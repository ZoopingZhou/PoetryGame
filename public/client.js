const socket = io();

// --- 获取所有需要的DOM元素 ---
const views = {
    lobby: document.getElementById('lobby-container'),
    game: document.getElementById('game-container'),
    nickname: document.getElementById('nickname-modal'),
    roomNotFound: document.getElementById('room-not-found-container'),
};
const lobbyElements = {
    roomList: document.getElementById('room-list'),
    createRoomBtn: document.getElementById('create-room-btn'),
};
const nicknameElements = {
    form: document.getElementById('nickname-form'),
    input: document.getElementById('nickname-input'),
    error: document.getElementById('nickname-error'),
    title: document.getElementById('nickname-prompt-title'),
    cancelBtn: document.getElementById('cancel-nickname-btn'),
};
const roomNotFoundElements = {
    invalidRoomId: document.getElementById('invalid-room-id'),
    goToLobbyBtn: document.getElementById('go-to-lobby-btn'),
    createThisRoomBtn: document.getElementById('create-this-room-btn'),
};
const gameElements = {
    leaveBtn: document.getElementById('leave-room-btn'),
    roomNameDisplay: document.getElementById('room-name-display'),
    messages: document.getElementById('messages'),
    form: document.getElementById('form'),
    input: document.getElementById('input'),
    submitAnswerBtn: document.getElementById('submit-answer-btn'),
    withdrawAnswerBtn: document.getElementById('withdraw-answer-btn'),
    startCharSpan: document.getElementById('start-char'),
    scoreBoard: document.getElementById('score-board'),
    gameStateSpan: document.getElementById('game-state'),
    queueList: document.getElementById('queue-list'),
    votePanel: document.getElementById('vote-panel'),
    charChoicePanel: document.getElementById('char-choice-panel'),
    charButtonsContainer: document.getElementById('char-buttons'),
    globalToast: document.getElementById('global-toast'),
};

// --- 客户端状态变量 ---
let currentAction = null;
let targetRoomId = null;
let targetRoomName = null;
let voteTimerInterval = null;
let choiceTimerInterval = null;
let myNickname = null;
let toastTimeout = null;

function resetClientState() {
    currentAction = null;
    targetRoomId = null;
    targetRoomName = null;
    myNickname = null;
    clearSession();
}

// ======================================================
// ========= 视图与UI工具函数 ===========================
// ======================================================
function showView(viewName) {
    for (const key in views) {
        views[key].style.display = 'none';
    }
    if (views[viewName]) {
        if (viewName === 'game') {
            views[viewName].style.display = 'flex';
        } else if (viewName === 'nickname' || viewName === 'roomNotFound') {
            views[viewName].style.display = 'flex';
        } else {
            views[viewName].style.display = 'block';
        }
    }
    // 每次切换视图都重新计算布局
    adaptLayout();
    setGameContainerHeight();
}

function showGlobalToast(message) {
    clearTimeout(toastTimeout);
    gameElements.globalToast.textContent = message;
    gameElements.globalToast.classList.add('show');
    toastTimeout = setTimeout(() => {
        gameElements.globalToast.classList.remove('show');
    }, 3000);
}

// ======================================================
// ========= 路由器 (Router) ============================
// ======================================================
function handleRouting() {
    const path = window.location.pathname;
    const match = path.match(/^\/room\/([a-zA-Z0-9]+)$/);
    if (match) {
        const roomId = match[1];
        const session = getSession(roomId);
        if (session) {
            myNickname = session.nickname;
            socket.emit('reconnectPlayer', session);
            showView('game');
        } else {
            socket.emit('validateRoom', roomId);
        }
    } else {
        showView('lobby');
        socket.emit('getRooms');
    }
}

// ======================================================
// ========= 会话管理 (Session Management) ==============
// ======================================================
function saveSession(roomId, nickname) {
    myNickname = nickname;
    sessionStorage.setItem('poetryGameSession', JSON.stringify({ roomId, nickname }));
}
function getSession(roomId) {
    const sessionStr = sessionStorage.getItem('poetryGameSession');
    if (!sessionStr) return null;
    const session = JSON.parse(sessionStr);
    return session.roomId === roomId ? session : null;
}
function clearSession() {
    myNickname = null;
    sessionStorage.removeItem('poetryGameSession');
}

// ======================================================
// ========= 统一的UI渲染函数 ==========================
// ======================================================
function renderGame(state) {
    if (state.players && myNickname && !state.players[myNickname]) {
        resetClientState();
        history.pushState(null, '', '/');
        handleRouting();
        showGlobalToast('您已离开房间或被移出');
        return;
    }
    
    gameElements.messages.innerHTML = '';
    if (state.messages) {
        state.messages.forEach(msg => {
            appendMessage(msg);
        });
    }
    gameElements.messages.scrollTop = gameElements.messages.scrollHeight;

    gameElements.scoreBoard.innerHTML = '';
    if (state.players) {
        for (const [playerId, playerData] of Object.entries(state.players)) {
            const li = document.createElement('li');
            const onlineStatus = playerData.online ? '' : ' (离线)';
            li.textContent = `${playerData.nickname}: ${playerData.score} 分${onlineStatus}`;
            if (playerData.nickname === myNickname) {
                li.style.fontWeight = 'bold';
                li.textContent = `${playerData.nickname} (你): ${playerData.score} 分${onlineStatus}`;
            }
            gameElements.scoreBoard.appendChild(li);
        }
    }

    gameElements.startCharSpan.textContent = state.currentStartChar || '?';
    gameElements.gameStateSpan.textContent = state.gameStateMessage || '连接中...';

    const queue = state.queue || [];
    gameElements.queueList.innerHTML = '';
    queue.forEach((submission) => {
        const li = document.createElement('li');
        li.textContent = `[${submission.answer}] - by ${submission.nickname}`;
        gameElements.queueList.appendChild(li);
    });

    const hasSubmittedAnswer = queue.some(sub => sub.nickname === myNickname);
    if (state.isChoosingChar) {
        gameElements.input.disabled = true;
        gameElements.input.value = '';
        gameElements.input.placeholder = '等待胜利者选择新字...';
        gameElements.submitAnswerBtn.style.display = 'block';
        gameElements.withdrawAnswerBtn.style.display = 'none';
    } else if (!state.playable) {
        gameElements.input.disabled = true;
        gameElements.input.value = '';
        gameElements.input.placeholder = '等待更多玩家加入...';
        gameElements.submitAnswerBtn.style.display = 'block';
        gameElements.withdrawAnswerBtn.style.display = 'none';
    } else if (hasSubmittedAnswer) {
        gameElements.input.disabled = true;
        gameElements.input.placeholder = '你已提交答案，等待或撤回...';
        gameElements.submitAnswerBtn.style.display = 'none';
        gameElements.withdrawAnswerBtn.style.display = 'block';
    } else {
        gameElements.input.disabled = false;
        gameElements.input.placeholder = '请输入诗句...';
        gameElements.submitAnswerBtn.style.display = 'block';
        gameElements.withdrawAnswerBtn.style.display = 'none';
    }

    const votePanel = gameElements.votePanel;
    clearInterval(voteTimerInterval);
    clearInterval(choiceTimerInterval);

    if (state.currentVote) {
        const { submission, voters } = state.currentVote;
        const voteContent = votePanel.querySelector('.vote-content');
        const voteWaiting = votePanel.querySelector('.vote-waiting');
        
        if (myNickname === submission.nickname) {
            voteContent.style.display = 'none';
            voteWaiting.style.display = 'block';
            voteWaiting.querySelector('strong').textContent = submission.answer;
        } else if (voters.includes(myNickname)) {
            voteContent.style.display = 'block';
            voteWaiting.style.display = 'none';
            
            const voteAnswerSpan = votePanel.querySelector('#vote-answer');
            const voteValidBtn = votePanel.querySelector('#vote-valid');
            const voteInvalidBtn = votePanel.querySelector('#vote-invalid');
            voteAnswerSpan.textContent = submission.answer;

            const newValidBtn = voteValidBtn.cloneNode(true);
            voteValidBtn.parentNode.replaceChild(newValidBtn, voteValidBtn);
            newValidBtn.addEventListener('click', () => {
                socket.emit('submitVote', 'valid');
            });

            const newInvalidBtn = voteInvalidBtn.cloneNode(true);
            voteInvalidBtn.parentNode.replaceChild(newInvalidBtn, voteInvalidBtn);
            newInvalidBtn.addEventListener('click', () => {
                socket.emit('submitVote', 'invalid');
            });
        } else {
            voteContent.style.display = 'none';
            voteWaiting.style.display = 'block';
            voteWaiting.innerHTML = `<p>正在对 [<strong>${submission.answer}</strong>] 进行投票，请等待本轮结束...</p>`;
        }
        
        if (state.currentVote.endTime) {
            const voteTimerSpan = votePanel.querySelector('#vote-timer');
            const updateTimer = () => {
                const remainingSeconds = Math.max(0, Math.round((state.currentVote.endTime - Date.now()) / 1000));
                voteTimerSpan.textContent = remainingSeconds;
                if (remainingSeconds <= 0) {
                    clearInterval(voteTimerInterval);
                }
            };
            updateTimer();
            voteTimerInterval = setInterval(updateTimer, 1000);
        }
        votePanel.style.display = 'block';
    } else {
        votePanel.style.display = 'none';
    }

    const choicePanel = gameElements.charChoicePanel;
    if (state.choice && state.choice.winnerNickname === myNickname) {
        gameElements.charButtonsContainer.innerHTML = '';
        const uniqueChars = [...new Set(state.choice.answer.replace(/[\s\p{P}]/gu, ''))];
        uniqueChars.forEach((char) => {
            const button = document.createElement('button');
            button.className = 'char-choice-btn';
            button.textContent = char;
            button.addEventListener('click', () => {
                socket.emit('chooseNewChar', { char: char });
            });
            gameElements.charButtonsContainer.appendChild(button);
        });

        if (state.choice.endTime) {
            const choiceTimerSpan = document.getElementById('choice-timer');
            const updateTimer = () => {
                const remainingSeconds = Math.max(0, Math.round((state.choice.endTime - Date.now()) / 1000));
                choiceTimerSpan.textContent = remainingSeconds;
                if (remainingSeconds <= 0) {
                    clearInterval(choiceTimerInterval);
                }
            };
            updateTimer();
            choiceTimerInterval = setInterval(updateTimer, 1000);
        }
        choicePanel.style.display = 'block';
    } else {
        choicePanel.style.display = 'none';
    }
}

// ======================================================
// ========= 事件监听器绑定 ============================
// ======================================================
lobbyElements.createRoomBtn.addEventListener('click', () => {
    currentAction = 'create_random';
    nicknameElements.title.textContent = '创建新房间';
    nicknameElements.error.textContent = ''; 
    showView('nickname');
    nicknameElements.input.focus();
});

nicknameElements.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = nicknameElements.input.value.trim();
    if (!nickname) return;
    if (currentAction === 'create_random') {
        socket.emit('createRoom', { nickname: nickname });
    } else if (currentAction === 'create_from_url') {
        socket.emit('createRoom', { roomName: targetRoomName, nickname: nickname });
    } else if (currentAction === 'join') {
        socket.emit('joinRoom', { roomId: targetRoomId, nickname: nickname });
    }
});

nicknameElements.cancelBtn.addEventListener('click', () => {
    nicknameElements.input.value = '';
    nicknameElements.error.textContent = '';
    handleRouting();
});

roomNotFoundElements.goToLobbyBtn.addEventListener('click', () => {
    history.pushState(null, '', '/');
    handleRouting();
});

roomNotFoundElements.createThisRoomBtn.addEventListener('click', () => {
    currentAction = 'create_from_url';
    targetRoomName = roomNotFoundElements.invalidRoomId.textContent;
    nicknameElements.title.textContent = `创建房间: ${targetRoomName}`;
    showView('nickname');
    nicknameElements.input.focus();
});

gameElements.leaveBtn.addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetClientState();
    history.pushState(null, '', '/');
    handleRouting();
});

gameElements.form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (gameElements.input.value && !gameElements.input.disabled) {
        socket.emit('submitAnswer', gameElements.input.value);
        gameElements.input.value = '';
    }
});

gameElements.withdrawAnswerBtn.addEventListener('click', () => {
    socket.emit('withdrawAnswer');
});

// ======================================================
// ========= Socket 事件处理 ============================
// ======================================================
socket.on('roomListUpdate', (rooms) => {
    lobbyElements.roomList.innerHTML = '';
    if (rooms.length === 0) {
        const li = document.createElement('li');
        li.className = 'no-rooms';
        li.textContent = '暂无房间，快去创建一个吧！';
        lobbyElements.roomList.appendChild(li);
    } else {
        rooms.forEach((room) => {
            const li = document.createElement('li');
            const nameSpan = document.createElement('span');
            nameSpan.className = 'room-name';
            nameSpan.textContent = room.name;
            const playersSpan = document.createElement('span');
            playersSpan.className = 'room-players';
            playersSpan.textContent = `(${room.playerCount}/8)`;
            const joinBtn = document.createElement('button');
            joinBtn.className = 'join-room-btn';
            joinBtn.textContent = '加入';
            joinBtn.addEventListener('click', () => {
                currentAction = 'join';
                targetRoomId = room.id;
                nicknameElements.title.textContent = `加入房间: ${room.name}`;
                nicknameElements.error.textContent = '';
                showView('nickname');
                nicknameElements.input.focus();
            });
            li.appendChild(nameSpan);
            li.appendChild(playersSpan);
            li.appendChild(joinBtn);
            lobbyElements.roomList.appendChild(li);
        });
    }
});

socket.on('roomValidationResult', ({ exists, roomName, roomId }) => {
    if (exists) {
        currentAction = 'join';
        targetRoomId = roomId;
        nicknameElements.title.textContent = `加入房间: ${roomName}`;
        nicknameElements.error.textContent = '';
        showView('nickname');
        nicknameElements.input.focus();
    } else {
        const path = window.location.pathname;
        const match = path.match(/^\/room\/([a-zA-Z0-9]+)$/);
        roomNotFoundElements.invalidRoomId.textContent = match ? match[1] : '未知';
        showView('roomNotFound');
    }
});

socket.on('joinSuccess', ({ roomId, roomName }) => {
    if (currentAction) {
        saveSession(roomId, nicknameElements.input.value.trim());
    }
    history.pushState({ roomId: roomId }, `Room ${roomName}`, `/room/${roomId}`);
    showView('game');
    gameElements.roomNameDisplay.textContent = roomName;
    currentAction = null;
});

socket.on('joinError', (errorMsg) => {
    nicknameElements.error.textContent = errorMsg;
});

socket.on('reconnectError', (errorMsg) => {
    console.error(`Reconnect failed: ${errorMsg}`);
    const session = JSON.parse(sessionStorage.getItem('poetryGameSession'));
    if (session) {
        roomNotFoundElements.invalidRoomId.textContent = session.roomId;
    }
    resetClientState();
    showView('roomNotFound');
});

function appendMessage(msg) {
    const item = document.createElement('li');
    item.className = msg.className || 'game-message';
    item.textContent = msg.content;
    gameElements.messages.appendChild(item);
    gameElements.messages.scrollTop = gameElements.messages.scrollHeight;
}

socket.on('newMessage', (msg) => {
    appendMessage(msg);
});

socket.on('gameStateUpdate', (state) => {
    renderGame(state);
});

function handleForcedExit(reason) {
    if (views.game.style.display !== 'flex') return;
    resetClientState();
    history.pushState(null, '', '/');
    handleRouting();
    showGlobalToast(reason);
    socket.disconnect().connect();
}

socket.on('kicked', (reason) => {
    handleForcedExit(reason);
});

socket.on('roomClosed', (reason) => {
    handleForcedExit(reason);
});

socket.on('disconnect', (reason) => {
    if (views.game.style.display === 'flex') {
        handleForcedExit('与服务器的连接已断开');
    }
});

// ======================================================
// ========= 布局与尺寸适配 ============================
// ======================================================

// --- 拖动分割线实现 (仅桌面端) ---
const leftPanel = document.getElementById('left-panel');
const resizer = document.getElementById('resizer');
let isResizing = false;

if (resizer) {
    resizer.addEventListener('mousedown', function(e) {
        isResizing = true;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function(e) {
        if (!isResizing) return;
        const minWidth = 160;
        const maxWidth = 460;
        let newWidth = e.clientX;
        if (newWidth < minWidth) newWidth = minWidth;
        if (newWidth > maxWidth) newWidth = maxWidth;
        leftPanel.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', function() {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// --- 动态设置容器高度以适配移动端 ---
const gameContainer = document.getElementById('game-container');
function setGameContainerHeight() {
    if (gameContainer) {
        gameContainer.style.height = window.innerHeight + 'px';
    }
}

// --- 移动端布局适配 ---
function adaptLayout() {
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    document.body.classList.toggle('mobile-layout', isMobile);
}

// --- 初始加载与事件监听 ---
document.addEventListener('DOMContentLoaded', () => {
    handleRouting();
    setGameContainerHeight();
    adaptLayout();
});
window.addEventListener('popstate', handleRouting);
window.addEventListener('resize', () => {
    setGameContainerHeight();
    adaptLayout();
});
window.addEventListener('orientationchange', setGameContainerHeight);