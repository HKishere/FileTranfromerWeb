#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include <string>
#include <vector>
#include <cstdint>
#include <functional>
#include <memory>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <atomic>
#include <chrono>
#include <websocketpp/config/asio_no_tls.hpp>
#include <websocketpp/server.hpp>

// WebSocket 操作码（保留兼容性）
enum class WebSocketOpcode : uint8_t {
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA
};

// WebSocket 帧结构（保留兼容性）
struct WebSocketFrame {
    bool fin;
    WebSocketOpcode opcode;
    bool mask;
    uint8_t maskKey[4];
    uint64_t payloadLength;
    std::vector<uint8_t> payloadData;
};

// 客户端信息
struct ClientInfo {
    int fd;
    std::string id;
    std::string name;
    std::string address;
    bool authenticated;
    std::chrono::steady_clock::time_point lastPing;
};

// 文件传输信息
struct FileTransferInfo {
    std::string fileId;
    std::string fileName;
    uint64_t fileSize;
    uint64_t bytesSent;
    std::string fromClientId;
    std::string toClientId;
    std::vector<uint8_t> fileData;
    std::chrono::steady_clock::time_point startTime;
    bool complete;
};

// 消息回调类型
using WebSocketMessageCallback = std::function<void(int fd, const WebSocketFrame& frame)>;
using WebSocketOpenCallback = std::function<void(int fd, const std::string& address)>;
using WebSocketCloseCallback = std::function<void(int fd)>;

// WebSocket 服务器封装类
class WebSocketServer {
public:
    WebSocketServer();
    ~WebSocketServer();

    // 初始化并启动服务器
    bool init(uint16_t port);
    void stop();
    void run();

    // 发送消息
    void sendText(int fd, const std::string& message);
    void sendBinary(int fd, const std::vector<uint8_t>& data);
    void sendPing(int fd);
    void sendPong(int fd, const std::vector<uint8_t>& payload = {});
    void sendClose(int fd, uint16_t code = 1000, const std::string& reason = "");
    void broadcastText(const std::string& message, const std::function<bool(int)>& filter = nullptr);

    // 关闭连接
    void closeConnection(int fd);

    // 设置回调
    void setMessageCallback(WebSocketMessageCallback callback);
    void setOpenCallback(WebSocketOpenCallback callback);
    void setCloseCallback(WebSocketCloseCallback callback);

    // 获取连接地址
    std::string getAddress(int fd);

private:
    // websocketpp 类型定义
    typedef websocketpp::server<websocketpp::config::asio> WSServer;
    typedef websocketpp::connection_hdl ConnectionHandle;

    // 内部回调处理
    void onOpen(ConnectionHandle hdl);
    void onClose(ConnectionHandle hdl);
    void onMessage(ConnectionHandle hdl, WSServer::message_ptr msg);

    // 工具函数
    int getFdFromHandle(ConnectionHandle hdl);
    ConnectionHandle getHandleFromFd(int fd);

    WSServer m_server;
    std::thread m_serverThread;
    std::atomic<bool> m_running;
    uint16_t m_port;

    // 连接映射
    std::mutex m_mutex;
    std::map<int, ConnectionHandle> m_fdToHandle;
    std::map<ConnectionHandle, int, std::owner_less<ConnectionHandle>> m_handleToFd;
    std::map<int, std::string> m_fdToAddress;
    int m_nextFd;

    // 回调
    WebSocketMessageCallback m_messageCallback;
    WebSocketOpenCallback m_openCallback;
    WebSocketCloseCallback m_closeCallback;
};

// 旧的 WebSocket 工具函数（保留兼容性）
namespace WebSocket {

// Base64 编码/解码（保留兼容性）
std::string base64Encode(const std::vector<uint8_t>& data);
std::vector<uint8_t> base64Decode(const std::string& encoded);

} // namespace WebSocket

#endif // WEBSOCKET_H
