#ifndef SERVER_H
#define SERVER_H

#include <string>
#include <vector>
#include <map>
#include <set>
#include <functional>
#include <thread>
#include <mutex>
#include <atomic>
#include <iostream>
#include <sstream>
#include <fstream>
#include <chrono>
#include <iomanip>
#include <random>

#include "websocket.h"
#include <openssl/hmac.h>
#include <openssl/evp.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>

class Server {
public:
    Server(int port, const std::string& passwdFile);
    ~Server();
    bool start();
    void stop();
    void run();

private:
    int m_port;
    std::string m_passwdFile;
    std::string m_password;
    std::string m_jwtSecret;
    
    WebSocketServer m_wsServer;
    std::atomic<bool> m_running;
    std::map<int, ClientInfo> m_clients;
    std::map<std::string, int> m_clientIdToFd;
    std::map<std::string, FileTransferInfo> m_fileTransfers;
    std::mutex m_mutex;
    
    bool loadPassword();
    void initJwtSecret();
    static std::string base64UrlEncode(const std::string& data);
    static std::string base64UrlDecode(const std::string& data);
    static std::string hmacSha256(const std::string& key, const std::string& data);
    std::string generateToken(const std::string& clientId);
    bool verifyToken(const std::string& token, std::string& outClientId);
    
    void onWebSocketOpen(int fd, const std::string& address);
    void onWebSocketClose(int fd);
    void onWebSocketMessage(int fd, const WebSocketFrame& frame);
    void handleAuth(int fd, const std::string& password);
    void handleTokenAuth(int fd, const std::string& token);
    void handleTextMessage(int fd, const std::string& toClientId, const std::string& content);
    void handleFileMeta(int fd, const std::string& toClientId, const std::string& fileName, 
                        uint64_t fileSize, const std::string& fileId);
    void handleWebRTCSignaling(int fd, const std::string& type, const std::string& message);
    void handleFileChunk(int fd, const std::string& fileId, uint64_t offset, const std::string& data);
    void handleFileComplete(int fd, const std::string& toClientId, const std::string& fileId,
                            const std::string& fileName, uint64_t fileSize);
    void handleBinaryFileChunk(int fd, const std::vector<uint8_t>& payload);
    void broadcastClientList();
    std::string generateClientId();
    std::string getCurrentTime();
};

#endif