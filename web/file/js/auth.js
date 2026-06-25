// 鉴权页面 JavaScript

// 检查是否已认证
function checkAuth() {
    const token = sessionStorage.getItem('auth_token');
    if (token) {
        window.location.href = 'dashboard.html';
    }
}

// 页面加载时检查
document.addEventListener('DOMContentLoaded', function() {
    checkAuth();
    
    // 回车键触发鉴权
    document.getElementById('password').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            authenticate();
        }
    });
});

// 鉴权函数
function authenticate() {
    const password = document.getElementById('password').value;
    const authBtn = document.getElementById('authBtn');
    const authError = document.getElementById('authError');
    
    if (!password) {
        showError('请输入密码');
        return;
    }
    
    authBtn.disabled = true;
    authBtn.textContent = '鉴权中...';
    authError.style.display = 'none';
    
    // 创建 WebSocket 连接进行鉴权
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Nginx 将 /ws 路径代理到后端 WebSocket 服务
    const wsUrl = protocol + '//' + window.location.host + '/ws';
    
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = function() {
        // 发送鉴权消息
        const authMsg = JSON.stringify({
            type: 'auth',
            password: password
        });
        ws.send(authMsg);
    };
    
    ws.onmessage = function(event) {
        try {
            const response = JSON.parse(event.data);
            
            if (response.type === 'auth_result') {
                if (response.success) {
                    // 保存认证信息（JWT token 和 client_id）
                    sessionStorage.setItem('auth_token', response.token);
                    sessionStorage.setItem('client_id', response.client_id);
                    
                    // 关闭鉴权用的 WebSocket 连接
                    ws.close();
                    
                    // 跳转到主页面
                    window.location.href = 'dashboard.html';
                } else {
                    showError('密码错误，请重试');
                    authBtn.disabled = false;
                    authBtn.textContent = '鉴权';
                    ws.close();
                }
            }
        } catch (e) {
            console.error('解析响应失败:', e);
            showError('服务器响应异常');
            authBtn.disabled = false;
            authBtn.textContent = '鉴权';
            ws.close();
        }
    };
    
    ws.onerror = function() {
        showError('无法连接到服务器');
        authBtn.disabled = false;
        authBtn.textContent = '鉴权';
    };
    
    ws.onclose = function() {
        if (authBtn.disabled) {
            showError('连接被关闭');
            authBtn.disabled = false;
            authBtn.textContent = '鉴权';
        }
    };
}

function showError(message) {
    const authError = document.getElementById('authError');
    authError.textContent = message;
    authError.style.display = 'block';
}
