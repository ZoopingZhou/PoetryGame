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

function getSerializableRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    const onlinePlayers = Object.values(room.players).filter(p => p.online).length;
    const isPlayable = onlinePlayers >= 2;
    
    let gameStateMessage = '等待输入';
    if (room.currentVote) {
        gameStateMessage = '投票中';
    } else if (choiceTimeouts[roomId]) {
        const winnerNickname = choiceTimeouts[roomId].winnerNickname || '一位玩家';
        gameStateMessage = `选择新字 (等待【${winnerNickname}】)`;
    } else if (room.validationQueue.length > 0) {
        gameStateMessage = `验证中 ([${room.validationQueue[0].answer}])`;
    } else if (!isPlayable) {
        gameStateMessage = '等待玩家...';
    }

    return {
        // 构造一个不暴露 socketId 的 players 对象给客户端
        players: Object.fromEntries(
            Object.entries(room.players).map(([nickname, data]) => [
                nickname,
                { nickname: data.nickname, score: data.score, online: data.online },
            ])
        ),
        currentStartChar: room.currentStartChar,
        queue: room.validationQueue,
        currentVote: room.currentVote ? {
            submission: room.currentVote.submission,
            voters: room.currentVote.voters,
            votes: room.currentVote.votes,
            endTime: room.currentVote.endTime,
        } : null,
        choice: choiceTimeouts[roomId] ? { 
            winnerNickname: choiceTimeouts[roomId].winnerNickname,
            answer: choiceTimeouts[roomId].answer,
            endTime: choiceTimeouts[roomId].endTime,
        } : null, 
        playable: isPlayable,
        // 明确的布尔标记，表示是否正处于选字阶段
        isChoosingChar: !!choiceTimeouts[roomId],
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

    // 在 socket 连接对象上附加一个查找函数，方便后续使用
    socket.getPlayerInfo = function() {
        if (!this.roomId || !this.nickname) return null;
        return rooms[this.roomId]?.players[this.nickname];
    };

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
        if (socket.roomId) handlePlayerInput(socket, socket.roomId, answer);
    });

    socket.on('withdrawAnswer', () => {
        if (!socket.roomId || !socket.nickname) return;
        const room = rooms[socket.roomId];
        const nickname = socket.nickname;

        const isVotingOnThis = room.currentVote && room.currentVote.submission.nickname === nickname;
        
        const initialLength = room.validationQueue.length;
        room.validationQueue = room.validationQueue.filter(
            (submission) => submission.nickname !== nickname
        );

        if (room.validationQueue.length < initialLength && room.players[nickname] && socket.roomId) {
            io.to(socket.roomId).emit('gameMessage', `玩家【${nickname}】撤回了答案。`);
            
            if (isVotingOnThis) {
                Object.values(room.currentVote.timeouts).forEach(clearTimeout);
                room.currentVote = null;
                io.to(socket.roomId).emit('gameMessage', `投票已中断。`);
            }
            broadcastGameState(socket.roomId);
            processValidationQueue(socket.roomId);
        }
    });

    socket.on('submitVote', (vote) => {
        if (socket.roomId) handlePlayerVote(socket, socket.roomId, vote);
    });
    socket.on('chooseNewChar', ({ char }) => {
        if (socket.roomId) handleCharChoice(socket, socket.roomId, char);
    });
});

function handlePlayerDisconnect(socket, { graceful = false }) {
    const { roomId, nickname } = socket;
    if (!roomId || !nickname) return;

    const room = rooms[roomId];
    const player = room.players[nickname];
    if (!player) return;

    if (graceful) {
        io.to(roomId).emit('gameMessage', `--- 玩家【${player.nickname}】离开了房间 ---`);
        delete room.players[nickname];
    } else {
        player.online = false;
        io.to(roomId).emit(
            'gameMessage',
            `--- 玩家【${player.nickname}】已断开连接，等待重连... ---`
        );
        reconnectTimeouts[nickname] = setTimeout(() => {
            if (
                rooms[roomId] &&
                rooms[roomId].players[nickname] &&
                !rooms[roomId].players[nickname].online
            ) {
                console.log(
                    `玩家【${player.nickname}】重连超时，已从房间 [${roomId}] 移除。`
                );
                delete rooms[roomId].players[nickname];
                delete reconnectTimeouts[nickname];
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
    
    const offlinePlayer = room.players[nickname];
    if (offlinePlayer) {
        reconnectPlayer(socket, roomId, nickname);
    } else {
        socket.leave('lobby');
        socket.join(roomId);
        // 附加身份信息到 socket
        socket.roomId = roomId;
        socket.nickname = nickname;

        room.players[nickname] = { nickname: nickname, score: 0, online: true, socketId: socket.id };
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

function reconnectPlayer(socket, roomId, nickname) {
    const room = rooms[roomId];
    if (!room) {
        socket.emit('reconnectError', '房间已不存在。');
        return;
    }
    const playerData = room.players[nickname];

    if (playerData && !playerData.online) {
        clearTimeout(reconnectTimeouts[nickname]);
        delete reconnectTimeouts[nickname];

        playerData.online = true;
        playerData.socketId = socket.id;

        socket.leave('lobby');
        socket.join(roomId);
        // 附加身份信息到 socket
        socket.roomId = roomId;
        socket.nickname = nickname;

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
                    // 保存时，擦除临时的 socketId
                    players: Object.fromEntries(
                        Object.entries(rooms[roomId].players).map(([nick, data]) => [
                            nick,
                            { nickname: data.nickname, score: data.score, online: false },
                        ])
                    ),
                    currentStartChar: rooms[roomId].currentStartChar,
                    usedSentences: rooms[roomId].usedSentences,
                    validationQueue: rooms[roomId].validationQueue,
                    currentVote: rooms[roomId].currentVote ? {
                        submission: rooms[roomId].currentVote.submission,
                        votes: rooms[roomId].currentVote.votes,
                        voters: rooms[roomId].currentVote.voters,
                        endTime: rooms[roomId].currentVote.endTime,
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
    const { nickname } = socket;
    if (!nickname || !room.players[nickname]) return;

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
    const winnerPlayer = room.players[submission.nickname];
    if (!room || !winnerPlayer) {
        room.validationQueue = [];
        broadcastGameState(roomId);
        processValidationQueue(roomId);
        return;
    }
    
    winnerPlayer.score++;
    scheduleSaveRooms();
    room.validationQueue = [];
    const normalizedAnswer = normalizeSentence(submission.answer);
    room.usedSentences.push(normalizedAnswer);
    if (room.usedSentences.length > 50) {
        room.usedSentences.shift();
    }
    
    const winnerNickname = winnerPlayer.nickname;
    const CHOICE_DURATION_MS = 15000;
    const choiceEndTime = Date.now() + CHOICE_DURATION_MS;
    choiceTimeouts[roomId] = {
        winnerNickname: winnerNickname,
        answer: submission.answer,
        endTime: choiceEndTime,
        timer: setTimeout(() => {
            if (choiceTimeouts[roomId]) {
                // 超时后，删除状态并由系统开启新一轮
                const timeoutWinnerNickname = choiceTimeouts[roomId].winnerNickname;
                delete choiceTimeouts[roomId]; 
                io.to(roomId).emit(
                    'gameMessage',
                    `玩家【${timeoutWinnerNickname}】选择超时，系统将自动选择。`
                );
                const randomChar = normalizeSentence(submission.answer)[0] || '天';
                startNewRound(roomId, randomChar, '系统');
            }
        }, CHOICE_DURATION_MS),
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

    const VOTE_DURATION_MS = 15000;
    const voteEndTime = Date.now() + VOTE_DURATION_MS;
    const timeouts = {};
    voters.forEach(nickname => {
        timeouts[nickname] = setTimeout(() => {
            handleVoteTimeout(roomId, nickname);
        }, VOTE_DURATION_MS);
    });

    room.currentVote = {
        submission: submission,
        votes: {},
        endTime: voteEndTime,
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
    const { nickname } = socket;
    if (!room || !room.currentVote || !nickname || !room.players[nickname]) return;
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
    const { nickname } = socket;
    if (!room || !roomChoiceTimeout) return;
    if (nickname === roomChoiceTimeout.winnerNickname) {
        clearTimeout(roomChoiceTimeout.timer);
        delete choiceTimeouts[roomId];
        startNewRound(roomId, char, nickname);
    }
}

function startNewRound(roomId, newChar, chooserId) {
    const room = rooms[roomId];
    if (!room) return;
    room.currentStartChar = newChar;
    const chooserNickname =
        chooserId === '系统'
            ? '系统' // chooserId is a nickname or '系统'
            : chooserId;
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
            // 在加载时，确保所有玩家都是离线状态，因为 socketId 已经失效
            for (const roomId in rooms) {
                for (const nickname in rooms[roomId].players) {
                    rooms[roomId].players[nickname].online = false;
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