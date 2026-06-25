#include "websocket.h"
#include <iostream>
#include <algorithm>
#include <stdexcept>
#include <cstring>
#include <random>

// ==================== WebSocketServer 实现 ====================

WebSocketServer::WebSocketServer()
    : m_running(false)
    , m_port(0)
    , m_nextFd(1)
{
    // 设置日志
    m_server.set_access_channels(websocketpp::log::alevel::none);
    m_server.set_error_channels(websocketpp::log::elevel::none);

    // 初始化 ASIO
    m_server.init_asio();

    // 设置回调
    m_server.set_open_handler(std::bind(&WebSocketServer::onOpen, this, std::placeholders::_1));
    m_server.set_close_handler(std::bind(&WebSocketServer::onClose, this, std::placeholders::_1));
    m_server.set_message_handler(std::bind(&WebSocketServer::onMessage, this,
        std::placeholders::_1, std::placeholders::_2));
}

WebSocketServer::~WebSocketServer() {
    stop();
}

bool WebSocketServer::init(uint16_t port) {
    m_port = port;

    try {
        // 设置地址重用，防止端口被占用时启动失败
        m_server.set_reuse_addr(true);

        // 监听端口
        m_server.listen(port);

        // 开始接受连接
        m_server.start_accept();

        std::cout << "WebSocket server (websocketpp) initialized on port " << port << std::endl;
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Failed to initialize WebSocket server: " << e.what() << std::endl;
        return false;
    }
}

void WebSocketServer::stop() {
    m_running = false;

    try {
        // 停止监听
        m_server.stop_listening();

        // 关闭所有连接
        std::lock_guard<std::mutex> lock(m_mutex);
        for (auto& [fd, hdl] : m_fdToHandle) {
            try {
                auto con = m_server.get_con_from_hdl(hdl);
                con->close(websocketpp::close::status::going_away, "Server shutting down");
            } catch (...) {}
        }
        m_fdToHandle.clear();
        m_handleToFd.clear();
        m_fdToAddress.clear();

        // 停止 ASIO
        m_server.stop();
    } catch (const std::exception& e) {
        std::cerr << "Error stopping WebSocket server: " << e.what() << std::endl;
    }

    if (m_serverThread.joinable()) {
        m_serverThread.join();
    }
}

void WebSocketServer::run() {
    m_running = true;
    std::cout << "WebSocket server running on ws://0.0.0.0:" << m_port << "/" << std::endl;
    std::cout << "Nginx should proxy /ws to this port" << std::endl;

    // websocketpp 的 run() 是阻塞的，在单独的线程中运行
    m_serverThread = std::thread([this]() {
        try {
            m_server.run();
        } catch (const std::exception& e) {
            std::cerr << "WebSocket server run error: " << e.what() << std::endl;
        }
    });
}

void WebSocketServer::sendText(int fd, const std::string& message) {
    try {
        auto hdl = getHandleFromFd(fd);
        m_server.send(hdl, message, websocketpp::frame::opcode::text);
    } catch (const std::exception& e) {
        std::cerr << "sendText error (fd=" << fd << "): " << e.what() << std::endl;
    }
}

void WebSocketServer::sendBinary(int fd, const std::vector<uint8_t>& data) {
    try {
        auto hdl = getHandleFromFd(fd);
        m_server.send(hdl, data.data(), data.size(), websocketpp::frame::opcode::binary);
    } catch (const std::exception& e) {
        std::cerr << "sendBinary error (fd=" << fd << "): " << e.what() << std::endl;
    }
}

void WebSocketServer::sendPing(int fd) {
    try {
        auto hdl = getHandleFromFd(fd);
        m_server.ping(hdl, "");
    } catch (const std::exception& e) {
        std::cerr << "sendPing error (fd=" << fd << "): " << e.what() << std::endl;
    }
}

void WebSocketServer::sendPong(int fd, const std::vector<uint8_t>& payload) {
    try {
        auto hdl = getHandleFromFd(fd);
        m_server.pong(hdl, std::string(payload.begin(), payload.end()));
    } catch (const std::exception& e) {
        std::cerr << "sendPong error (fd=" << fd << "): " << e.what() << std::endl;
    }
}

void WebSocketServer::sendClose(int fd, uint16_t code, const std::string& reason) {
    try {
        auto hdl = getHandleFromFd(fd);
        m_server.close(hdl, code, reason);
    } catch (const std::exception& e) {
        std::cerr << "sendClose error (fd=" << fd << "): " << e.what() << std::endl;
    }
}

void WebSocketServer::broadcastText(const std::string& message, const std::function<bool(int)>& filter) {
    std::lock_guard<std::mutex> lock(m_mutex);
    for (auto& [fd, hdl] : m_fdToHandle) {
        if (!filter || filter(fd)) {
            try {
                m_server.send(hdl, message, websocketpp::frame::opcode::text);
            } catch (const std::exception& e) {
                std::cerr << "broadcast error (fd=" << fd << "): " << e.what() << std::endl;
            }
        }
    }
}

void WebSocketServer::closeConnection(int fd) {
    try {
        auto hdl = getHandleFromFd(fd);
        auto con = m_server.get_con_from_hdl(hdl);
        con->close(websocketpp::close::status::normal, "Closed by server");
    } catch (const std::exception& e) {
        std::cerr << "closeConnection error (fd=" << fd << "): " << e.what() << std::endl;
    }
}

std::string WebSocketServer::getAddress(int fd) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_fdToAddress.find(fd);
    if (it != m_fdToAddress.end()) {
        return it->second;
    }
    return "unknown";
}

void WebSocketServer::setMessageCallback(WebSocketMessageCallback callback) {
    m_messageCallback = callback;
}

void WebSocketServer::setOpenCallback(WebSocketOpenCallback callback) {
    m_openCallback = callback;
}

void WebSocketServer::setCloseCallback(WebSocketCloseCallback callback) {
    m_closeCallback = callback;
}

// ==================== 内部回调 ====================

void WebSocketServer::onOpen(ConnectionHandle hdl) {
    int fd;
    std::string address;

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        fd = m_nextFd++;
        m_fdToHandle[fd] = hdl;
        m_handleToFd[hdl] = fd;

        // 获取客户端地址
        try {
            auto con = m_server.get_con_from_hdl(hdl);
            address = con->get_remote_endpoint();
        } catch (...) {
            address = "unknown";
        }
        m_fdToAddress[fd] = address;
    }

    std::cout << "New WebSocket connection (fd=" << fd << ") from " << address << std::endl;

    if (m_openCallback) {
        m_openCallback(fd, address);
    }
}

void WebSocketServer::onClose(ConnectionHandle hdl) {
    int fd = -1;

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_handleToFd.find(hdl);
        if (it != m_handleToFd.end()) {
            fd = it->second;
            m_fdToHandle.erase(fd);
            m_fdToAddress.erase(fd);
            m_handleToFd.erase(it);
        }
    }

    if (fd >= 0) {
        std::cout << "WebSocket connection closed (fd=" << fd << ")" << std::endl;
        if (m_closeCallback) {
            m_closeCallback(fd);
        }
    }
}

void WebSocketServer::onMessage(ConnectionHandle hdl, WSServer::message_ptr msg) {
    int fd = getFdFromHandle(hdl);
    if (fd < 0) return;

    // 将 websocketpp 消息转换为旧的 WebSocketFrame 格式
    WebSocketFrame frame;
    frame.fin = true;
    frame.mask = false;
    memset(frame.maskKey, 0, sizeof(frame.maskKey));

    auto& payload = msg->get_raw_payload();
    frame.payloadLength = payload.size();
    frame.payloadData.assign(payload.begin(), payload.end());

    switch (msg->get_opcode()) {
        case websocketpp::frame::opcode::text:
            frame.opcode = WebSocketOpcode::TEXT;
            break;
        case websocketpp::frame::opcode::binary:
            frame.opcode = WebSocketOpcode::BINARY;
            break;
        case websocketpp::frame::opcode::ping:
            frame.opcode = WebSocketOpcode::PING;
            break;
        case websocketpp::frame::opcode::pong:
            frame.opcode = WebSocketOpcode::PONG;
            break;
        case websocketpp::frame::opcode::close:
            frame.opcode = WebSocketOpcode::CLOSE;
            break;
        default:
            frame.opcode = WebSocketOpcode::CONTINUATION;
            break;
    }

    if (m_messageCallback) {
        m_messageCallback(fd, frame);
    }
}

// ==================== 工具函数 ====================

int WebSocketServer::getFdFromHandle(ConnectionHandle hdl) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_handleToFd.find(hdl);
    if (it != m_handleToFd.end()) {
        return it->second;
    }
    return -1;
}

WebSocketServer::ConnectionHandle WebSocketServer::getHandleFromFd(int fd) {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_fdToHandle.find(fd);
    if (it != m_fdToHandle.end()) {
        return it->second;
    }
    throw std::runtime_error("Connection not found for fd: " + std::to_string(fd));
}

// ==================== Base64 工具（保留兼容性） ====================

namespace WebSocket {

static const char base64Chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::vector<uint8_t>& data) {
    std::string result;
    size_t i = 0;
    while (i < data.size()) {
        uint32_t triple = 0;
        int remaining = 0;
        for (int j = 0; j < 3 && i < data.size(); j++, i++) {
            triple = (triple << 8) | data[i];
            remaining++;
        }
        if (remaining == 3) {
            result += base64Chars[(triple >> 18) & 0x3F];
            result += base64Chars[(triple >> 12) & 0x3F];
            result += base64Chars[(triple >> 6) & 0x3F];
            result += base64Chars[triple & 0x3F];
        } else if (remaining == 2) {
            result += base64Chars[(triple >> 18) & 0x3F];
            result += base64Chars[(triple >> 12) & 0x3F];
            result += base64Chars[(triple >> 6) & 0x3F];
            result += '=';
        } else if (remaining == 1) {
            result += base64Chars[(triple >> 18) & 0x3F];
            result += base64Chars[(triple >> 12) & 0x3F];
            result += "==";
        }
    }
    return result;
}

std::vector<uint8_t> base64Decode(const std::string& encoded) {
    std::vector<uint8_t> result;
    std::vector<int> decodeTable(256, -1);
    for (int i = 0; i < 64; i++) {
        decodeTable[static_cast<unsigned char>(base64Chars[i])] = i;
    }

    size_t i = 0;
    while (i < encoded.size() && encoded[i] != '=') {
        uint32_t quadruple = 0;
        int validChars = 0;
        for (int j = 0; j < 4 && i < encoded.size() && encoded[i] != '='; j++, i++) {
            int val = decodeTable[static_cast<unsigned char>(encoded[i])];
            if (val == -1) continue;
            quadruple = (quadruple << 6) | val;
            validChars++;
        }
        if (validChars >= 2) {
            result.push_back((quadruple >> 16) & 0xFF);
        }
        if (validChars >= 3) {
            result.push_back((quadruple >> 8) & 0xFF);
        }
        if (validChars >= 4) {
            result.push_back(quadruple & 0xFF);
        }
    }
    return result;
}

} // namespace WebSocket
