# macOS 登录自启

Heartbeat 的本地桌面安装入口使用 `http://127.0.0.1:27101/`。生产服务使用相同端口，因此登录后可直接打开已安装的应用。

启动项文件为 `~/Library/LaunchAgents/com.heartbeat-management.plist`：

- 登录时启动，异常退出后自动重启；
- 执行构建后的 `dist/server/index.js`，不依赖开发服务器；
- 仅监听本机回环地址；
- 日志写入 `~/Library/Logs/heartbeat-management/`。

更新代码后，先在项目目录执行 `npm run build`，再执行：

```sh
launchctl kickstart -k gui/$(id -u)/com.heartbeat-management
```

停止自启服务：

```sh
launchctl bootout gui/$(id -u)/com.heartbeat-management
```
