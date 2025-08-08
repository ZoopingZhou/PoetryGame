const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const VALID_SENTENCES_FILE = path.join(DATA_DIR, 'valid_sentences.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

let rooms = {};
let localCache = [];
let reconnectTimeouts = {};
let choiceTimeouts = {};
const RECONNECT_TIMEOUT_MS = 30000;

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

function broadcastRoomList() {
    const roomList = getLobbyInfo();
    io.to('lobby').emit('roomListUpdate', roomList);
    io.to('admin').emit('adminDataUpdate'); // 通知管理员界面更新
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
        isChoosingChar: !!choiceTimeouts[roomId],
        gameStateMessage: gameStateMessage,
        messages: room.messages,
    };
}

function broadcastGameState(roomId) {
    const state = getSerializableRoomState(roomId);
    if (state) {
        io.to(roomId).emit('gameStateUpdate', state);
    }
    io.to('admin').emit('adminDataUpdate'); // 玩家状态变化也通知管理员
}

function sendPrivateMessage(socket, messageContent) {
    if (!socket) return;
    const message = {
        content: messageContent,
        className: 'private-message',
        timestamp: Date.now(),
    };
    socket.emit('newMessage', message);
}

function broadcastMessage(roomId, messageContent, messageClass = 'game-message') {
    const room = rooms[roomId];
    if (!room) return;

    const message = {
        content: messageContent,
        className: messageClass,
        timestamp: Date.now(),
    };
    
    room.messages.push(message);
    if (room.messages.length > 50) room.messages.shift();
    io.to(roomId).emit('newMessage', message);
}

// ======================================================
// Admin Panel Logic
// ======================================================
let adminConfig = {};

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

async function verifyPassword(password, salt, hash) {
    return hashPassword(password, salt) === hash;
}

app.use(cookieParser());
app.use(bodyParser.json());
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

const authMiddleware = (req, res, next) => {
    if (req.session.isAdmin) {
        next();
    } else {
        res.status(401).json({ message: '未授权' });
    }
};

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', async (req, res) => {
    const { password } = req.body;
    if (!adminConfig.salt || !adminConfig.hash) {
        return res.status(403).json({ message: '管理员密码尚未设置' });
    }
    const isValid = await verifyPassword(password, adminConfig.salt, adminConfig.hash);
    if (isValid) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ message: '密码错误' });
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// API routes
const adminApiRouter = express.Router();
adminApiRouter.use(authMiddleware);

adminApiRouter.get('/status', (req, res) => {
    res.json({ isAdmin: true });
});

adminApiRouter.get('/data', (req, res) => {
    const roomList = Object.values(rooms).map(room => ({
        id: room.id,
        playerCount: Object.values(room.players).filter(p => p.online).length,
        isPermanent: !!room.isPermanent
    }));
    res.json({ rooms: roomList, cache: [...localCache].sort() });
});

adminApiRouter.get('/rooms/:roomId/players', (req, res) => {
    const { roomId } = req.params;
    const room = rooms[roomId];
    if (room) {
        res.json(Object.values(room.players));
    } else {
        res.status(404).json({ message: '房间不存在' });
    }
});

adminApiRouter.post('/rooms/toggle-permanent', (req, res) => {
    const { roomId } = req.body;
    if (rooms[roomId]) {
        rooms[roomId].isPermanent = !rooms[roomId].isPermanent;
        res.json({ success: true, isPermanent: rooms[roomId].isPermanent });
        scheduleSaveRooms();
    } else {
        res.status(404).json({ message: '房间不存在' });
    }
});

adminApiRouter.post('/rooms/delete', (req, res) => {
    const { roomId } = req.body;
    if (rooms[roomId]) {
        io.to(roomId).emit('roomClosed', '房间已被管理员解散');
        
        Object.values(rooms[roomId].players).forEach(player => {
            if (player.online && io.sockets.sockets.get(player.socketId)) {
                setTimeout(() => {
                    const socket = io.sockets.sockets.get(player.socketId);
                    if (socket) socket.disconnect(true);
                }, 50);
            }
        });

        delete rooms[roomId];
        broadcastRoomList();
        res.json({ success: true });
        scheduleSaveRooms();
    } else {
        res.status(404).json({ message: '房间不存在' });
    }
});

adminApiRouter.post('/cache/add', (req, res) => {
    const { sentence } = req.body;
    const normalized = normalizeSentence(sentence);
    if (normalized && !localCache.includes(normalized)) {
        localCache.push(normalized);
        localCache.sort();
        scheduleSaveCache();
        res.json({ success: true });
    } else {
        res.status(400).json({ message: '诗句无效或已存在' });
    }
});

adminApiRouter.post('/cache/delete', (req, res) => {
    const { sentence } = req.body;
    const normalized = normalizeSentence(sentence);
    const index = localCache.indexOf(normalized);
    if (index > -1) {
        localCache.splice(index, 1);
        scheduleSaveCache();
        res.json({ success: true });
    } else {
        res.status(404).json({ message: '诗句不存在' });
    }
});

adminApiRouter.post('/rooms/players/delete', (req, res) => {
    const { roomId, nickname } = req.body;
    const room = rooms[roomId];
    if (room && room.players[nickname]) {
        const player = room.players[nickname];

        // 1. 如果玩家在线，通知并断开连接
        if (player.online && io.sockets.sockets.get(player.socketId)) {
            const targetSocket = io.sockets.sockets.get(player.socketId);
            targetSocket.emit('kicked', '您已被管理员移出房间');
            setTimeout(() => {
                if (targetSocket) targetSocket.disconnect(true);
            }, 50);
        }

        // 2. 无论在线与否，都直接、无条件地从数据中移除
        removePlayerFromRoom(roomId, nickname);

        // 3. 广播状态更新
        broadcastGameState(roomId); // 更新房间内其他玩家的视图
        broadcastRoomList();      // 更新大厅和管理员界面的玩家计数

        res.json({ success: true });
    } else {
        res.status(404).json({ message: '玩家或房间不存在' });
    }
});

app.use('/admin/api', adminApiRouter);

function removePlayerFromRoom(roomId, nickname) {
    const room = rooms[roomId];
    if (!room || !room.players[nickname]) return false;

    delete room.players[nickname];
    delete reconnectTimeouts[nickname];

    if (Object.keys(room.players).length === 0 && !room.isPermanent) {
        console.log(`房间 [${roomId}] 因无人而销毁。`);
        delete rooms[roomId];
        return true;
    }
    return false;
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`一位玩家已连接: ${socket.id}`);
    
    socket.on('joinAdmin', () => {
        socket.join('admin');
    });

    socket.join('lobby');

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
            isPermanent: false,
            currentStartChar: '月',
            usedSentences: [],
            validationQueue: [],
            currentVote: null,
            messages: [],
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
            broadcastMessage(socket.roomId, `玩家【${nickname}】撤回了答案。`);
            
            if (isVotingOnThis) {
                Object.values(room.currentVote.timeouts).forEach(clearTimeout);
                room.currentVote = null;
                broadcastMessage(socket.roomId, `投票已中断。`);
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
    if (!room) {
        return;
    }

    const player = room.players[nickname];
    if (!player) return;

    if (graceful) {
        if (room.isPermanent) {
            player.online = false;
            player.disconnectTime = Date.now();
            broadcastMessage(roomId, `--- 玩家【${player.nickname}】离开了房间 ---`);
        } else {
            broadcastMessage(roomId, `--- 玩家【${player.nickname}】离开了房间 ---`);
            removePlayerFromRoom(roomId, nickname);
        }
    } else {
        player.online = false;
        player.disconnectTime = Date.now();
        broadcastMessage(roomId, `--- 玩家【${player.nickname}】已断开连接，等待重连... ---`);

        if (room.isPermanent) {
            broadcastGameState(roomId);
            return;
        }

        reconnectTimeouts[nickname] = setTimeout(() => {
            if (
                rooms[roomId] &&
                rooms[roomId].players[nickname] &&
                !rooms[roomId].players[nickname].online
            ) {
                console.log(
                    `玩家【${player.nickname}】重连超时，已从房间 [${roomId}] 移除。`
                );
                if (!removePlayerFromRoom(roomId, nickname)) {
                    broadcastMessage(roomId, `--- 玩家【${player.nickname}】已掉线 ---`);
                    broadcastGameState(roomId);
                }
                scheduleSaveRooms();
                broadcastRoomList();
            }
        }, RECONNECT_TIMEOUT_MS);
    }

    socket.leave(roomId);

    if (room.currentVote?.voters.includes(player.nickname) && !room.currentVote.votes[player.nickname]) {
        clearTimeout(room.currentVote.timeouts[player.nickname]);
        delete room.currentVote.timeouts[player.nickname];
        room.currentVote.votes[player.nickname] = 'valid';
        broadcastMessage(roomId, `玩家【${player.nickname}】断开连接，自动计为赞同。`);
        
        if (Object.keys(room.currentVote.votes).length >= room.currentVote.voters.length) {
            handleVoteEnd(roomId);
        }
    }

    if (rooms[roomId]) {
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
        socket.roomId = roomId;
        socket.nickname = nickname;

        room.players[nickname] = { nickname: nickname, score: 0, online: true, socketId: socket.id };
        socket.emit('joinSuccess', { roomId: roomId, roomName: room.name });
        broadcastMessage(roomId, `--- 欢迎玩家【${nickname}】加入房间！ ---`);
        
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
        delete playerData.disconnectTime;

        socket.leave('lobby');
        socket.join(roomId);
        socket.roomId = roomId;
        socket.nickname = nickname;

        socket.emit('joinSuccess', { roomId: roomId, roomName: room.name });
        broadcastMessage(roomId, `--- 玩家【${nickname}】已重新连接！ ---`);
        
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
                    isPermanent: rooms[roomId].isPermanent,
                    players: Object.fromEntries(
                        Object.entries(rooms[roomId].players).map(([nick, data]) => [
                            nick,
                            { nickname: data.nickname, score: data.score, online: false, disconnectTime: data.disconnectTime },
                        ])
                    ),
                    currentStartChar: rooms[roomId].currentStartChar,
                    usedSentences: rooms[roomId].usedSentences,
                    validationQueue: rooms[roomId].validationQueue,
                    messages: rooms[roomId].messages,
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
        sendPrivateMessage(socket, '提示：你已提交一个答案，请等待验证或撤回。');
        return;
    }
    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) return;
    const illegalCharsRegex = /[\s\p{P}]/u;
    if (illegalCharsRegex.test(trimmedAnswer)) {
        sendPrivateMessage(socket, '提示：输入不应包含内部空格或任何标点符号。');
        return;
    }
    const normalizedAnswer = normalizeSentence(trimmedAnswer);
    if (room.usedSentences.includes(normalizedAnswer)) {
        sendPrivateMessage(socket, `提示：诗句 [${trimmedAnswer}] 最近已被使用，请换一个。`);
        return;
    }
    if (!trimmedAnswer.includes(room.currentStartChar)) {
        sendPrivateMessage(socket, '提示：您的答案不包含起始字，未被提交。');
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
    broadcastMessage(roomId, `正在验证 [${submission.answer}] (来自玩家【${submission.nickname}】)...`);
    const normalizedKey = normalizeSentence(submission.answer);
    if (localCache.includes(normalizedKey)) {
        room.validationQueue.shift();
        broadcastMessage(roomId, `[${submission.answer}] 命中缓存，确认为合法诗句！`);
        handleCorrectAnswer(roomId, submission);
        return;
    }
    broadcastMessage(roomId, `[${submission.answer}] 将由玩家投票决定其有效性...`);
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
                const timeoutWinnerNickname = choiceTimeouts[roomId].winnerNickname;
                delete choiceTimeouts[roomId]; 
                broadcastMessage(roomId, `玩家【${timeoutWinnerNickname}】选择超时，系统将自动选择。`);
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
    broadcastMessage(roomId, `玩家【${nickname}】投票超时，自动计为赞同。`);
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
        broadcastMessage(roomId, `玩家【${nickname}】已投票。`);
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
        broadcastMessage(roomId, `[${submission.answer}] 无人投票，自动通过！`);
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
        broadcastMessage(roomId, `[${submission.answer}] 投票通过！`);
        if (!localCache.includes(normalizedKey)) {
            localCache.push(normalizedKey);
        }
        scheduleSaveCache();
        handleCorrectAnswer(roomId, submission);
    } else {
        broadcastMessage(roomId, `[${submission.answer}] 投票未通过。`);
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
            ? '系统'
            : chooserId;
    broadcastMessage(roomId, `🎉 ${chooserNickname} 指定新起始字为【${newChar}】。新一轮开始！`);
    broadcastGameState(roomId);
}

async function loadAdminConfig() {
    try {
        const adminData = await fs.readFile(ADMIN_FILE, 'utf8');
        adminConfig = JSON.parse(adminData);
        console.log('管理员配置已加载。');
    } catch (error) {
        console.error('错误：管理员配置文件 (data/admin.json) 未找到或无法读取。');
        console.error('请先运行 "node setup.js" 来设置管理员密码。');
        process.exit(1);
    }
}


(async function loadData() {
    try {
        await loadAdminConfig();
        await fs.mkdir(DATA_DIR, { recursive: true });
        try {
            const roomsData = await fs.readFile(ROOMS_FILE, 'utf8');
            rooms = JSON.parse(roomsData);

            for (const roomId in rooms) {
                if (!rooms[roomId].messages) rooms[roomId].messages = [];
                for (const nickname in rooms[roomId].players) {
                    const player = rooms[roomId].players[nickname];
                    player.online = false;

                    if (player.disconnectTime) {
                        if (rooms[roomId].isPermanent) {
                            continue;
                        }

                        const offlineDuration = Date.now() - player.disconnectTime;
                        if (offlineDuration >= RECONNECT_TIMEOUT_MS) {
                            console.log(`玩家【${nickname}】在服务器重启后因超时被移除。`);
                            removePlayerFromRoom(roomId, nickname);
                        } else {
                            const remainingTime = RECONNECT_TIMEOUT_MS - offlineDuration;
                            reconnectTimeouts[nickname] = setTimeout(() => {
                                if (rooms[roomId]?.players[nickname] && !rooms[roomId].players[nickname].online) {
                                    console.log(`玩家【${nickname}】重连超时，已从房间 [${roomId}] 移除。`);
                                    if (!removePlayerFromRoom(roomId, nickname)) {
                                        broadcastMessage(roomId, `--- 玩家【${nickname}】已掉线 ---`);
                                        broadcastGameState(roomId);
                                    }
                                    broadcastRoomList();
                                }
                            }, remainingTime);
                        }
                    }
                }
                if (!rooms[roomId]) continue;
            }
            console.log('房间数据已成功加载。');
        } catch (error) {
            console.log('未找到 rooms.json，将使用空房间列表。', error.message);
            rooms = {};
        }
        try {
            const cacheData = await fs.readFile(VALID_SENTENCES_FILE, 'utf8');
            const parsedCache = JSON.parse(cacheData);
            localCache = Array.isArray(parsedCache) ? parsedCache : [];
            console.log('有效诗句缓存已成功加载。');
        } catch (error) {
            console.log(`未找到 ${VALID_SENTENCES_FILE}，将使用空缓存。`, error.message);
            localCache = [];
        }
    } catch (error) {
        console.error('加载数据时发生错误:', error);
    }
})();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器正在端口 ${PORT} 上运行`));