const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const VALID_SENTENCES_FILE = path.join(DATA_DIR, 'valid_sentences.json');

let rooms = {};
let localCache = [];
let reconnectTimeouts = {};
let choiceTimeouts = {};

let saveRoomsTimeout = null;
let saveCacheTimeout = null;

function normalizeSentence(sentence) {
    return sentence.replace(/[\s\p{P}]/gu, '');
}

function getLobbyInfo() {
    const roomList = [];
    for (const roomId in rooms) {
        roomList.push({
            id: roomId,
            name: rooms[roomId].name,
            playerCount: Object.values(rooms[roomId].players).filter((p) => p.online)
                .length,
        });
    }
    return roomList;
}

// ======================================================
// 【关键修复】: 恢复被意外删除的 broadcastRoomList 函数
// ======================================================
function broadcastRoomList() {
    io.to('lobby').emit('roomListUpdate', getLobbyInfo());
}

function findRoomBySocketId(socketId) {
    for (const roomId in rooms) {
        if (rooms[roomId].players[socketId]) {
            return roomId;
        }
    }
    return null;
}
function findNicknameBySocketId(roomId, socketId) {
    return rooms[roomId]?.players[socketId]?.nickname;
}

function getSerializableRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    const onlinePlayers = Object.values(room.players).filter(p => p.online).length;
    const isPlayable = onlinePlayers >= 2;
    
    let gameStateMessage = '等待输入';
    if (room.currentVote) {
        gameStateMessage = '投票中';
    } else if (choiceTimeouts[roomId]) {
        const winnerNickname = room.players[choiceTimeouts[roomId].winnerId]?.nickname || '';
        gameStateMessage = `选择新字 (等待【${winnerNickname}】)`;
    } else if (room.validationQueue.length > 0) {
        gameStateMessage = `验证中 ([${room.validationQueue[0].answer}])`;
    } else if (!isPlayable) {
        gameStateMessage = '等待玩家...';
    }

    return {
        players: room.players,
        currentStartChar: room.currentStartChar,
        queue: room.validationQueue,
        currentVote: room.currentVote ? {
            submission: room.currentVote.submission,
            voters: room.currentVote.voters,
            votes: room.currentVote.votes,
        } : null,
        choice: choiceTimeouts[roomId] ? { 
            winnerId: choiceTimeouts[roomId].winnerId, 
            answer: choiceTimeouts[roomId].answer 
        } : null,
        playable: isPlayable,
        gameStateMessage: gameStateMessage,
    };
}

function broadcastGameState(roomId) {
    const state = getSerializableRoomState(roomId);
    if (state) {
        io.to(roomId).emit('gameStateUpdate', state);
    }
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`一位玩家已连接: ${socket.id}`);
    socket.join('lobby');

    socket.on('getRooms', () => {
        socket.emit('roomListUpdate', getLobbyInfo());
    });

    socket.on('validateRoom', (roomId) => {
        if (rooms[roomId]) {
            socket.emit('roomValidationResult', {
                exists: true,
                roomName: rooms[roomId].name,
                roomId: roomId,
            });
        } else {
            socket.emit('roomValidationResult', { exists: false });
        }
    });

    socket.on('createRoom', ({ roomName, nickname }) => {
        const roomId = roomName || crypto.randomBytes(2).toString('hex').toUpperCase();
        if (rooms[roomId]) {
            socket.emit('joinError', `房间 "${roomId}" 已存在。`);
            return;
        }
        rooms[roomId] = {
            id: roomId,
            name: roomId,
            players: {},
            currentStartChar: '月',
            usedSentences: [],
            validationQueue: [],
            currentVote: null,
        };
        scheduleSaveRooms();
        console.log(`房间已创建: ${roomId}`);
        joinRoom(socket, roomId, nickname);
    });

    socket.on('joinRoom', ({ roomId, nickname }) => {
        if (!rooms[roomId]) {
            socket.emit('joinError', '房间不存在或已解散。');
            return;
        }
        joinRoom(socket, roomId, nickname);
    });

    socket.on('reconnectPlayer', ({ roomId, nickname }) => {
        reconnectPlayer(socket, roomId, nickname);
    });

    socket.on('leaveRoom', () => {
        handlePlayerDisconnect(socket, { graceful: true });
    });
    socket.on('disconnect', () => {
        console.log(`一位玩家已断开连接: ${socket.id}`);
        handlePlayerDisconnect(socket, { graceful: false });
    });

    socket.on('submitAnswer', (answer) => {
        const roomId = findRoomBySocketId(socket.id);
        if (roomId) handlePlayerInput(socket, roomId, answer);
    });

    socket.on('withdrawAnswer', () => {
        const roomId = findRoomBySocketId(socket.id);
        if (!roomId) return;
        const room = rooms[roomId];
        const nickname = findNicknameBySocketId(roomId, socket.id);
        if (!nickname) return;

        const isVotingOnThis = room.currentVote && room.currentVote.submission.nickname === nickname;
        
        const initialLength = room.validationQueue.length;
        room.validationQueue = room.validationQueue.filter(
            (submission) => submission.nickname !== nickname
        );

        if (room.validationQueue.length < initialLength) {
            io.to(roomId).emit('gameMessage', `玩家【${nickname}】撤回了答案。`);
            
            if (isVotingOnThis) {
                Object.values(room.currentVote.timeouts).forEach(clearTimeout);
                room.currentVote = null;
                io.to(roomId).emit('gameMessage', `投票已中断。`);
            }
            broadcastGameState(roomId);
            processValidationQueue(roomId);
        }
    });

    socket.on('submitVote', (vote) => {
        const roomId = findRoomBySocketId(socket.id);
        if (roomId) handlePlayerVote(socket, roomId, vote);
    });
    socket.on('chooseNewChar', ({ char }) => {
        const roomId = findRoomBySocketId(socket.id);
        if (roomId) handleCharChoice(socket, roomId, char);
    });
});

function handlePlayerDisconnect(socket, { graceful = false }) {
    const roomId = findRoomBySocketId(socket.id);
    if (!roomId) return;
    const room = rooms[roomId];
    const player = room.players[socket.id];
    if (!player) return;

    if (graceful) {
        io.to(roomId).emit('gameMessage', `--- 玩家【${player.nickname}】离开了房间 ---`);
        delete room.players[socket.id];
    } else {
        player.online = false;
        io.to(roomId).emit(
            'gameMessage',
            `--- 玩家【${player.nickname}】已断开连接，等待重连... ---`
        );
        reconnectTimeouts[socket.id] = setTimeout(() => {
            if (
                rooms[roomId] &&
                rooms[roomId].players[socket.id] &&
                !rooms[roomId].players[socket.id].online
            ) {
                console.log(
                    `玩家【${player.nickname}】重连超时，已从房间 [${roomId}] 移除。`
                );
                delete rooms[roomId].players[socket.id];
                delete reconnectTimeouts[socket.id];
                if (Object.keys(room.players).length === 0) {
                    delete rooms[roomId];
                    console.log(`房间 [${roomId}] 已被销毁。`);
                } else {
                    io.to(roomId).emit(
                        'gameMessage',
                        `--- 玩家【${player.nickname}】已掉线 ---`
                    );
                    broadcastGameState(roomId);
                }
                scheduleSaveRooms();
                broadcastRoomList();
            }
        }, 30000);
    }

    socket.leave(roomId);

    if (room.currentVote?.voters.includes(player.nickname) && !room.currentVote.votes[player.nickname]) {
        clearTimeout(room.currentVote.timeouts[player.nickname]);
        delete room.currentVote.timeouts[player.nickname];
        room.currentVote.votes[player.nickname] = 'valid';
        io.to(roomId).emit('gameMessage', `玩家【${player.nickname}】断开连接，自动计为赞同。`);
        
        if (Object.keys(room.currentVote.votes).length >= room.currentVote.voters.length) {
            handleVoteEnd(roomId);
        }
    }

    if (Object.keys(room.players).length === 0) {
        delete rooms[roomId];
        console.log(`房间 [${roomId}] 因无人而销毁。`);
    } else {
        broadcastGameState(roomId);
    }

    scheduleSaveRooms();
    broadcastRoomList();
}

function joinRoom(socket, roomId, nickname) {
    const room = rooms[roomId];
    if (!nickname || nickname.length > 10 || nickname.length < 1) {
        socket.emit('joinError', '昵称不合法 (1-10个字符)。');
        return;
    }
    const isTakenOnline = Object.values(room.players).some(
        (p) => p.nickname.toLowerCase() === nickname.toLowerCase() && p.online
    );
    if (isTakenOnline) {
        socket.emit('joinError', '该昵称在房间内已被使用。');
        return;
    }
    const offlinePlayer = Object.values(room.players).find(
        (p) => p.nickname.toLowerCase() === nickname.toLowerCase() && !p.online
    );
    if (offlinePlayer) {
        const oldSocketId = Object.keys(room.players).find(id => room.players[id] === offlinePlayer);
        reconnectPlayer(socket, roomId, nickname, oldSocketId);
    } else {
        socket.leave('lobby');
        socket.join(roomId);
        room.players[socket.id] = { nickname: nickname, score: 0, online: true };
        socket.emit('joinSuccess', { roomId: roomId, roomName: room.name });
        io.to(roomId).emit('gameMessage', `--- 欢迎玩家【${nickname}】加入房间！ ---`);
        
        if (room.currentVote) {
            socket.emit('voteInProgress', { answer: room.currentVote.submission.answer });
        }
        
        broadcastGameState(roomId);
        broadcastRoomList();
        scheduleSaveRooms();
    }
}

function reconnectPlayer(socket, roomId, nickname, existingPlayerId = null) {
    const room = rooms[roomId];
    if (!room) {
        socket.emit('reconnectError', '房间已不存在。');
        return;
    }
    let foundPlayerId = existingPlayerId;
    if (!foundPlayerId) {
        foundPlayerId = Object.keys(room.players).find(
            (id) => room.players[id].nickname === nickname && !room.players[id].online
        );
    }
    if (foundPlayerId) {
        const playerData = room.players[foundPlayerId];
        clearTimeout(reconnectTimeouts[foundPlayerId]);
        delete reconnectTimeouts[foundPlayerId];
        delete room.players[foundPlayerId];
        const newPlayerData = {
            nickname: playerData.nickname,
            score: playerData.score,
            online: true,
        };
        room.players[socket.id] = newPlayerData;
        socket.leave('lobby');
        socket.join(roomId);
        socket.emit('joinSuccess', { roomId: roomId, roomName: room.name });
        io.to(roomId).emit('gameMessage', `--- 玩家【${nickname}】已重新连接！ ---`);
        
        if (room.currentVote) {
            if (room.currentVote.voters.includes(nickname)) {
                if (!room.currentVote.votes[nickname]) {
                    clearTimeout(room.currentVote.timeouts[nickname]);
                    room.currentVote.timeouts[nickname] = setTimeout(() => {
                        handleVoteTimeout(roomId, nickname);
                    }, 15000);
                }
            } else {
                socket.emit('voteInProgress', { answer: room.currentVote.submission.answer });
            }
        }
        
        broadcastGameState(roomId);
        broadcastRoomList();
        scheduleSaveRooms();
    } else {
        socket.emit('reconnectError', '无法重连，请尝试使用新昵称加入。');
    }
}

function scheduleSaveRooms() {
    clearTimeout(saveRoomsTimeout);
    saveRoomsTimeout = setTimeout(async () => {
        try {
            const roomsToSave = {};
            for (const roomId in rooms) {
                roomsToSave[roomId] = {
                    id: rooms[roomId].id,
                    name: rooms[roomId].name,
                    players: rooms[roomId].players,
                    currentStartChar: rooms[roomId].currentStartChar,
                    usedSentences: rooms[roomId].usedSentences,
                    validationQueue: rooms[roomId].validationQueue,
                    currentVote: rooms[roomId].currentVote ? {
                        submission: rooms[roomId].currentVote.submission,
                        votes: rooms[roomId].currentVote.votes,
                        voters: rooms[roomId].currentVote.voters,
                    } : null,
                };
            }
            await fs.writeFile(ROOMS_FILE, JSON.stringify(roomsToSave, null, 2));
            console.log('房间数据已保存。');
        } catch (error) {
            console.error('保存房间数据失败:', error);
        }
    }, 2000);
}

function scheduleSaveCache() {
    clearTimeout(saveCacheTimeout);
    saveCacheTimeout = setTimeout(async () => {
        try {
            await fs.writeFile(VALID_SENTENCES_FILE, JSON.stringify(localCache, null, 2));
            console.log('有效诗句缓存已保存。');
        } catch (error) {
            console.error('保存诗句缓存失败:', error);
        }
    }, 2000);
}

function handlePlayerInput(socket, roomId, answer) {
    const room = rooms[roomId];
    const nickname = findNicknameBySocketId(roomId, socket.id);
    if (!nickname) return;

    const alreadySubmitted = room.validationQueue.some(s => s.nickname === nickname);
    if (alreadySubmitted) {
        socket.emit('gameMessage', '提示：你已提交一个答案，请等待验证或撤回。');
        return;
    }
    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) return;
    const illegalCharsRegex = /[\s\p{P}]/u;
    if (illegalCharsRegex.test(trimmedAnswer)) {
        socket.emit('gameMessage', '提示：输入不应包含内部空格或任何标点符号。');
        return;
    }
    const normalizedAnswer = normalizeSentence(trimmedAnswer);
    if (room.usedSentences.includes(normalizedAnswer)) {
        socket.emit('gameMessage', `提示：诗句 [${trimmedAnswer}] 最近已被使用，请换一个。`);
        return;
    }
    if (!trimmedAnswer.includes(room.currentStartChar)) {
        socket.emit('gameMessage', '提示：您的答案不包含起始字，未被提交。');
        return;
    }
    room.validationQueue.push({ answer: trimmedAnswer, nickname: nickname });
    broadcastGameState(roomId);
    processValidationQueue(roomId);
}

async function processValidationQueue(roomId) {
    const room = rooms[roomId];
    if (!room || room.currentVote || room.validationQueue.length === 0)
        return;
    
    const submission = room.validationQueue[0];
    broadcastGameState(roomId);
    io.to(roomId).emit(
        'gameMessage',
        `正在验证 [${submission.answer}] (来自玩家【${submission.nickname}】)...`
    );
    const normalizedKey = normalizeSentence(submission.answer);
    if (localCache.includes(normalizedKey)) {
        room.validationQueue.shift();
        io.to(roomId).emit(
            'gameMessage',
            `[${submission.answer}] 命中缓存，确认为合法诗句！`
        );
        handleCorrectAnswer(roomId, submission);
        return;
    }
    io.to(roomId).emit(
        'gameMessage',
        `[${submission.answer}] 将由玩家投票决定其有效性...`
    );
    startPlayerVote(roomId, submission);
}

function handleCorrectAnswer(roomId, submission) {
    const room = rooms[roomId];
    const winnerSocket = Object.entries(room.players).find(([id, player]) => player.nickname === submission.nickname && player.online);
    if (!room || !winnerSocket) {
        room.validationQueue = [];
        broadcastGameState(roomId);
        processValidationQueue(roomId);
        return;
    }
    
    const winnerSocketId = winnerSocket[0];
    room.players[winnerSocketId].score++;
    scheduleSaveRooms();
    room.validationQueue = [];
    const normalizedAnswer = normalizeSentence(submission.answer);
    room.usedSentences.push(normalizedAnswer);
    if (room.usedSentences.length > 50) {
        room.usedSentences.shift();
    }
    
    choiceTimeouts[roomId] = {
        winnerId: winnerSocketId,
        answer: submission.answer,
        timer: setTimeout(() => {
            if (choiceTimeouts[roomId]) {
                const winnerNickname = room.players[winnerSocketId]?.nickname;
                io.to(roomId).emit(
                    'gameMessage',
                    `玩家【${winnerNickname}】选择超时，系统将自动选择。`
                );
                const randomChar = normalizeSentence(submission.answer)[0] || '天';
                startNewRound(roomId, randomChar, '系统');
            }
        }, 15000),
    };
    broadcastGameState(roomId);
}

function startPlayerVote(roomId, submission) {
    const room = rooms[roomId];
    if (!room) return;
    
    const onlinePlayers = Object.values(room.players).filter(p => p.online);
    const voters = onlinePlayers
        .filter((player) => player.nickname !== submission.nickname)
        .map(player => player.nickname);

    const timeouts = {};
    voters.forEach(nickname => {
        timeouts[nickname] = setTimeout(() => {
            handleVoteTimeout(roomId, nickname);
        }, 15000);
    });

    room.currentVote = {
        submission: submission,
        votes: {},
        voters: voters,
        timeouts: timeouts,
    };
    broadcastGameState(roomId);
}

function handleVoteTimeout(roomId, nickname) {
    const room = rooms[roomId];
    if (!room || !room.currentVote || room.currentVote.votes[nickname]) return;

    room.currentVote.votes[nickname] = 'valid';
    delete room.currentVote.timeouts[nickname];
    io.to(roomId).emit('gameMessage', `玩家【${nickname}】投票超时，自动计为赞同。`);
    broadcastGameState(roomId);

    if (Object.keys(room.currentVote.votes).length >= room.currentVote.voters.length) {
        handleVoteEnd(roomId);
    }
}

function handlePlayerVote(socket, roomId, vote) {
    const room = rooms[roomId];
    const nickname = findNicknameBySocketId(roomId, socket.id);
    if (!room || !room.currentVote || !nickname) return;
    if (
        room.currentVote.voters.includes(nickname) &&
        !room.currentVote.votes[nickname]
    ) {
        clearTimeout(room.currentVote.timeouts[nickname]);
        delete room.currentVote.timeouts[nickname];

        room.currentVote.votes[nickname] = vote;
        io.to(roomId).emit(
            'gameMessage',
            `玩家【${nickname}】已投票。`
        );
        broadcastGameState(roomId);

        if (Object.keys(room.currentVote.votes).length >= room.currentVote.voters.length) {
            handleVoteEnd(roomId);
        }
    }
}

function handleVoteEnd(roomId) {
    const room = rooms[roomId];
    if (!room || !room.currentVote) return;
    
    Object.values(room.currentVote.timeouts).forEach(clearTimeout);

    const { submission, votes: voteData, voters } = room.currentVote;
    
    const totalVoters = voters.length;
    if (totalVoters === 0) {
        room.currentVote = null;
        room.validationQueue.shift();
        io.to(roomId).emit(
            'gameMessage',
            `[${submission.answer}] 无人投票，自动通过！`
        );
        const normalizedKey = normalizeSentence(submission.answer);
        if (!localCache.includes(normalizedKey)) {
            localCache.push(normalizedKey);
        }
        scheduleSaveCache();
        handleCorrectAnswer(roomId, submission);
        return;
    }

    const threshold = Math.floor(totalVoters / 2) + 1;
    const validVotes = Object.values(voteData).filter(v => v === 'valid').length;

    room.currentVote = null;
    room.validationQueue.shift();
    const normalizedKey = normalizeSentence(submission.answer);

    if (validVotes >= threshold) {
        io.to(roomId).emit(
            'gameMessage',
            `[${submission.answer}] 投票通过！`
        );
        if (!localCache.includes(normalizedKey)) {
            localCache.push(normalizedKey);
        }
        scheduleSaveCache();
        handleCorrectAnswer(roomId, submission);
    } else {
        io.to(roomId).emit(
            'gameMessage',
            `[${submission.answer}] 投票未通过。`
        );
        broadcastGameState(roomId);
        processValidationQueue(roomId);
    }
}

function handleCharChoice(socket, roomId, char) {
    const room = rooms[roomId];
    const roomChoiceTimeout = choiceTimeouts[roomId];
    if (!room || !roomChoiceTimeout) return;
    if (socket.id === roomChoiceTimeout.winnerId) {
        clearTimeout(roomChoiceTimeout.timer);
        delete choiceTimeouts[roomId];
        startNewRound(roomId, char, socket.id);
    }
}

function startNewRound(roomId, newChar, chooserId) {
    const room = rooms[roomId];
    if (!room) return;
    room.currentStartChar = newChar;
    const chooserNickname =
        chooserId === '系统'
            ? '系统'
            : room.players[chooserId]?.nickname || '一位玩家';
    io.to(roomId).emit(
        'gameMessage',
        `🎉 ${chooserNickname} 指定新起始字为【${newChar}】。新一轮开始！`
    );
    broadcastGameState(roomId);
}

(async function loadData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        try {
            const roomsData = await fs.readFile(ROOMS_FILE, 'utf8');
            rooms = JSON.parse(roomsData);
            for (const roomId in rooms) {
                for (const socketId in rooms[roomId].players) {
                    rooms[roomId].players[socketId].online = false;
                }
            }
            console.log('房间数据已成功加载。');
        } catch (error) {
            console.log('未找到 rooms.json，将使用空房间列表。');
            rooms = {};
        }
        try {
            const cacheData = await fs.readFile(VALID_SENTENCES_FILE, 'utf8');
            const parsedCache = JSON.parse(cacheData);
            localCache = Array.isArray(parsedCache) ? parsedCache : [];
            console.log('有效诗句缓存已成功加载。');
        } catch (error) {
            console.log(`未找到 ${VALID_SENTENCES_FILE}，将使用空缓存。`);
            localCache = [];
        }
    } catch (error) {
        console.error('加载数据时发生错误:', error);
    }
})();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器正在端口 ${PORT} 上运行`));