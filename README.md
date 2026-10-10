# dsh-volume-bar · 对话音量条

让 DSH 对话右侧的轮次导航栏随音乐跳动。

通过 **Windows WASAPI loopback** 捕获系统输出音频，播放音乐或视频时，各刻度会随对应频段的能量伸缩、变色。无需麦克风。

> A Windows-only DSH plugin that turns the conversation turn rail into a music-reactive volume bar using WASAPI loopback. MIT licensed.

## 预览

![音量条与轮次预览](docs/rail.png)

## 功能

- **分频动效**：低频在下、高频在上，每个刻度由对应频段驱动。
- **保留导航交互**：当前轮次高亮、悬停预览和键盘焦点照常使用。
- **独立设置页**：在 `设置 → 音量条` 调节开关、灵敏度、动效幅度和响应速度。
- **自动记忆设置**：下次打开 DSH 时恢复配置。
- **空会话也能用**：没有轮次时，显示 8 段备用音量条。
- **兼容降级**：无法挂载设置页时，显示角落开关按钮。

![设置 → 音量条](docs/settings.png)

## 安装

下载插件安装包后运行：

```powershell
dsh plugin --profile desktop add ".\dsh-volume-bar-0.4.0.tgz"
```

**重启 DSH**，进入 `设置 → 音量条` 打开开关。

首次启用会使用 DSH 自带 Python 创建虚拟环境，并自动安装 `pyaudiowpatch`，需要联网，通常耗时几十秒。

> 已在 DSH `0.2.0-rc.2` 桌面端的 `desktop` profile 上测试。升级插件后也需要重启 DSH。

## 设置

| 设置 | 作用 | 默认 |
|---|---|---|
| 对话音量条 | 开启或关闭，显示运行状态与输出设备 | 关闭 |
| 灵敏度 | 越高，越容易捕捉细微声音 | 50% |
| 动效幅度 | 越高，刻度伸缩越明显 | 50% |
| 响应速度 | 越高，动作越迅速；越低，过渡越柔和 | 50% |

点击「恢复默认」可将三个滑块重置为 50%。静音时，刻度保持短条形态。

## 开发与验证

在插件目录中打包：

```powershell
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" pack --pack-destination .
```

打开 `dev/demo.html` 可离线预览动效。Windows PowerShell 自检：

```powershell
powershell -ExecutionPolicy Bypass -File verify.ps1
# 播放测试音，检查是否捕获到真实信号
powershell -ExecutionPolicy Bypass -File verify.ps1 -Tone
```

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 管理音频进程与 HTTP 接口 |
| `lib/audio-levels.py` | 捕获系统输出，计算 RMS 和 8 个频段 |
| `lib/client.js` | 设置界面与导航栏动效 |
| `cordis.patch.yml` | 插件挂载配置 |

## 注意事项

- **仅支持 Windows**；macOS / Linux 暂无音频后端。
- 使用自适应增益，适合展示律动，不能作为绝对音量计。
- 导航栏定位依赖 DSH 的 DOM 与 CSS 类名，界面大改后可能需要适配。
- 本地 `/volume-bar/*` 接口没有鉴权，本机其他进程也能调用。
- 客户端超过 60 秒不再轮询时，音频进程自动停止。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-volume-bar
```

重启 DSH 后生效。可手动删除 `~/.dsh/tools/dsh-volume-bar` 中的依赖环境。

## License

MIT
