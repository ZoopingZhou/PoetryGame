document.addEventListener('DOMContentLoaded', () => {
    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');
    const loginForm = document.getElementById('login-form');
    const passwordInput = document.getElementById('password-input');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const playerModal = document.getElementById('player-modal');
    const playerModalTitle = document.getElementById('player-modal-title');
    const playerListBody = document.getElementById('player-list-body');
    const closeModalBtn = playerModal.querySelector('.close-btn');


    // --- API 请求封装 ---
    async function apiRequest(url, options = {}) {
        try {
            const response = await fetch(url, options);
            if (response.status === 401) {
                showLoginView();
                return null;
            }
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || '请求失败');
            }
            return response.json();
        } catch (error) {
            console.error('API请求错误:', error);
            alert(error.message);
            return null;
        }
    }

    // --- 视图切换 ---
    function showLoginView() {
        loginView.style.display = 'block';
        dashboardView.style.display = 'none';
    }

    function showDashboardView() {
        loginView.style.display = 'none';
        dashboardView.style.display = 'block';
        loadDashboardData();
    }

    // --- 登录/登出逻辑 ---
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = passwordInput.value;
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        const data = await response.json();
        if (response.ok) {
            showDashboardView();
        } else {
            loginError.textContent = data.message;
        }
    });

    logoutBtn.addEventListener('click', async () => {
        await fetch('/admin/logout', { method: 'POST' });
        showLoginView();
    });

    // --- 仪表盘数据加载和渲染 ---
    async function loadDashboardData() {
        const data = await apiRequest('/admin/api/data');
        if (data) {
            renderRoomList(data.rooms);
            renderCacheList(data.cache);
        }
    }

    // 渲染房间列表
    function renderRoomList(rooms) {
        const tbody = document.getElementById('room-list-body');
        tbody.innerHTML = '';
        rooms.forEach(room => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${room.id}</td>
                <td>${room.playerCount}</td>
                <td>
                    <input type="checkbox" class="permanent-toggle" data-room-id="${room.id}" ${room.isPermanent ? 'checked' : ''}>
                </td>
                <td>
                    <button class="action-btn manage-players-btn" data-room-id="${room.id}">管理玩家</button>
                </td>
                <td>
                    <button class="action-btn delete-btn" data-room-id="${room.id}">删除</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 渲染缓存列表
    const cacheList = document.getElementById('cache-list');
    let fullCache = [];
    function renderCacheList(cache) {
        fullCache = cache;
        const searchTerm = document.getElementById('cache-search-input').value.toLowerCase();
        cacheList.innerHTML = '';
        const filteredCache = cache.filter(item => item.toLowerCase().includes(searchTerm));
        
        filteredCache.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '删除';
            deleteBtn.className = 'action-btn delete-btn';
            deleteBtn.dataset.sentence = item;
            li.appendChild(deleteBtn);
            cacheList.appendChild(li);
        });
    }

    // 渲染玩家列表模态框
    function renderPlayerList(players, roomId) {
        playerListBody.innerHTML = '';
        players.forEach(player => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${player.nickname}</td>
                <td>${player.score}</td>
                <td>${player.online ? '在线' : '离线'}</td>
                <td>
                    <button class="action-btn delete-btn" data-room-id="${roomId}" data-nickname="${player.nickname}">移除</button>
                </td>
            `;
            playerListBody.appendChild(tr);
        });
    }

    // --- 模态框控制 ---
    function openPlayerModal(roomId) {
        playerModalTitle.textContent = `管理房间 [${roomId}] 的玩家`;
        playerModal.style.display = 'block';
        loadAndRenderPlayers(roomId);
    }
    closeModalBtn.onclick = () => playerModal.style.display = 'none';
    window.onclick = (e) => { if (e.target == playerModal) playerModal.style.display = 'none'; }

    // --- 仪表盘事件绑定 ---
    // 房间管理事件
    document.getElementById('room-management').addEventListener('click', async (e) => {
        const target = e.target;
        const roomId = target.dataset.roomId;
        if (!roomId) return;

        if (target.classList.contains('permanent-toggle')) {
            await apiRequest('/admin/api/rooms/toggle-permanent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomId }),
            });
            // 无需手动刷新，下次加载会自动更新
        } else if (target.classList.contains('delete-btn')) {
            if (confirm(`确定要强制删除房间 ${roomId} 吗？`)) {
                const result = await apiRequest('/admin/api/rooms/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ roomId }),
                });
                if (result) loadDashboardData();
            }
        } else if (target.classList.contains('manage-players-btn')) {
            openPlayerModal(roomId);
        }
    });

    // 玩家列表事件
    async function loadAndRenderPlayers(roomId) {
        const players = await apiRequest(`/admin/api/rooms/${roomId}/players`);
        if (players) {
            renderPlayerList(players, roomId);
        }
    }

    playerListBody.addEventListener('click', async (e) => {
        const target = e.target;
        if (target.classList.contains('delete-btn')) {
            const { roomId, nickname } = target.dataset;
            if (confirm(`确定要从房间 ${roomId} 中移除玩家 ${nickname} 吗？`)) {
                await apiRequest('/admin/api/rooms/players/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ roomId, nickname }),
                });
                loadAndRenderPlayers(roomId); // 刷新玩家列表
                loadDashboardData(); // 刷新房间列表（人数可能变化）
            }
        }
    });

    // 缓存管理事件
    document.getElementById('cache-search-input').addEventListener('input', () => renderCacheList(fullCache));
    
    document.getElementById('add-cache-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('add-cache-input');
        const sentence = input.value.trim();
        if (!sentence) return;
        const result = await apiRequest('/admin/api/cache/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sentence }),
        });
        if (result) {
            input.value = '';
            loadDashboardData();
        }
    });

    cacheList.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-btn')) {
            const sentence = e.target.dataset.sentence;
            if (confirm(`确定要从缓存中删除 "${sentence}" 吗？`)) {
                const result = await apiRequest('/admin/api/cache/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sentence }),
                });
                if (result) loadDashboardData();
            }
        }
    });

    // --- 初始加载 ---
    async function checkLoginStatus() {
        const response = await fetch('/admin/api/status');
        if (response.ok) {
            showDashboardView();
        } else {
            showLoginView();
        }
    }

    checkLoginStatus();
});