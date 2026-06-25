cmake_minimum_required(VERSION 3.10)
project(FileTransferServer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Boost REQUIRED COMPONENTS system thread date_time regex random)
find_package(OpenSSL REQUIRED)

set(SOURCES
    src/main.cpp
    src/server.cpp
    src/websocket.cpp
)

add_executable(fileserver ${SOURCES})

target_link_libraries(fileserver
    pthread
    OpenSSL::SSL
    OpenSSL::Crypto
    ${Boost_LIBRARIES}
)

target_include_directories(fileserver PRIVATE
    src
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${Boost_INCLUDE_DIRS}
)

target_compile_options(fileserver PRIVATE -Wall -Wextra -O2)
