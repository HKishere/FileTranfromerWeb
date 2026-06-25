// WebSocket 连接管理
// Nginx 反向代理配置：将 /ws 路径代理到后端 WebSocket 服务
// 依赖: transport.js (transportHandleMessage)

let ws = null;
let reconnectTimer = null;
let isConnected = false;

// 初始化 WebSocket 连接
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Nginx 将 /ws 路径代理到后端 WebSocket 服务
    const wsUrl = protocol + '//' + window.location.host + '/ws';
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = function() {
        console.log('WebSocket 连接已建立');
        isConnected = true;
        updateConnectionStatus(true);
        
        // 使用 JWT token 重新鉴权
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            sendMessage({
                type: 'token_auth',
                token: token
            });
        }
    };
    
    ws.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            // 所有消息统一由 transport 层分发
            if (typeof transportHandleMessage === 'function') {
                transportHandleMessage(data);
            }
        } catch (e) {
            console.error('解析消息失败:', e);
        }
    };
    
    ws.onerror = function(error) {
        console.error('WebSocket 错误:', error);
        isConnected = false;
        updateConnectionStatus(false);
    };
    
    ws.onclose = function() {
        console.log('WebSocket 连接已关闭');
        isConnected = false;
        updateConnectionStatus(false);
        
        // 自动重连
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(function() {
                reconnectTimer = null;
                if (!isConnected) {
                    console.log('尝试重新连接...');
                    initWebSocket();
                }
            }, 3000);
        }
    };
}

// 发送消息
function sendMessage(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
        return true;
    }
    console.error('WebSocket 未连接');
    return false;
}

// 更新连接状态显示
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connectionStatus');
    if (statusEl) {
        if (connected) {
            statusEl.textContent = '已连接';
            statusEl.className = 'status connected';
        } else {
            statusEl.textContent = '未连接';
            statusEl.className = 'status disconnected';
        }
    }
}

// 关闭连接
function closeWebSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    isConnected = false;
}
