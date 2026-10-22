# dsh-volume-bar · 对话音量条

让 DSH 对话右侧的轮次导航栏随音乐跳动，源于 codex 彩蛋。

通过 **Windows WASAPI loopback** 捕获系统输出音频，播放音乐或视频时，各刻度会随对应频段的能量伸缩。无需麦克风。

> A Windows-only DSH plugin that turns the conversation turn rail into a music-reactive volume bar using WASAPI loopback. MIT licensed.

## 预览

![音量条与轮次预览](docs/rail.png)

## 功能

- **分频动效**：低频在下、高频在上，每个刻度由对应频段驱动；刻度很少时也会覆盖整个频段范围。
- **保留导航交互**：当前轮次、悬停预览和键盘焦点始终优先，音乐只是装饰层，不会盖掉导航状态。
- **独立设置页**：`设置 → 音量条` 里有开关、三个滑块、动效预设、**试听预览**（不采集音频也能看效果）和采集设备选择。
- **自动记忆设置**：下次打开 DSH 时恢复配置；非法或旧版本的配置会逐字段回退到默认值。
- **不干扰界面**：新会话还没有轮次时什么都不画——插件只挂在导航栏上，不额外覆盖任何东西。
- **多窗口友好**：每个窗口持有一个采集租约，关掉一个窗口不会打断另一个窗口的音乐。
- **无 NumPy 也能用**：依赖缺失时降级为「只显示总电平」，并在设置页明确标出分析模式。
- **兼容降级**：无法挂载设置页时，显示角落开关按钮。

![设置 → 音量条](docs/settings.png)

## 安装

下载插件安装包后运行：

```powershell
dsh plugin --profile desktop add ".\dsh-volume-bar-0.7.0.tgz"
```

**重启 DSH**，进入 `设置 → 音量条` 打开开关。

首次启用会使用 DSH 自带 Python 创建虚拟环境，并自动安装 `pyaudiowpatch` 与 `numpy`，需要联网，通常耗时几十秒。安装完成后宿主会跑一次依赖探测（导入模块 + 枚举 loopback 设备），只有探测通过才算就绪。

> 已在 DSH `0.2.0-rc.2` 桌面端的 `desktop` profile 上测试。升级插件时：只改了浏览器半的版本刷新页面即可，动了宿主半（`lib/index.js` / `lib/audio-levels.py`）的版本要重启 DSH。

## 设置

| 设置 | 作用 | 默认 |
|---|---|---|
| 对话音量条 | 开启或关闭，显示运行状态、当前采集设备与分析模式 | 关闭 |
| 动效预设 | 「常规 / 专注 / 节奏」，会一起调整下面三个滑块 | 常规 |
| 灵敏度 | 越高，越容易捕捉细微声音 | 50% |
| 动效幅度 | 越高，刻度伸缩越明显 | 50% |
| 响应速度 | 越高，动作越迅速；越低，过渡越柔和 | 50% |
| 试听预览 | 用合成数据播放动效，不需要音频依赖；拖动滑块实时变化 | 停止 |
| 采集设备 | 跟随系统默认，或固定到某个输出设备 | 跟随系统默认 |

点击「恢复默认」可重置全部设置。静音时刻度保持短条形态；「诊断信息」折叠区会显示协议版本、分析模式、可见刻度数、`captureState`、`seq` 和帧龄。

响应速度对应的是**毫秒级时间常数**，动画按每帧真实时间差计算，所以 60 Hz 和 144 Hz 屏幕上的回落时间一致。

## 工作原理

```
浏览器半 (lib/client.js)          宿主半 (lib/index.js)              音频助手 (lib/audio-levels.py)
  ├─ 用户开关 = enabled             ├─ 会话租约（每个窗口一份）        ├─ WASAPI loopback 采集
  ├─ 轮询 /levels（45ms）           ├─ 依赖安装任务 + 健康探测         ├─ 2048 采样窗、1024 步长
  ├─ 按 seq/generation 判断新帧     ├─ 帧协议：generation/seq/ageMs    ├─ 逐声道能量合并 + 8 频段 RMS
  └─ 时间平滑 → 刻度 CSS 变量       └─ 最后一个租约释放才停止助手      └─ stdin `stop` / EOF 优雅退出
```

### 帧协议（v2）

`GET /volume-bar/levels` 返回：

| 字段 | 含义 |
|---|---|
| `protocolVersion` | 协议版本，客户端据此判断兼容性 |
| `generation` | 助手进程代次，重启后变化 |
| `frameGeneration` / `seq` | 该帧来自哪个代次、第几帧；两者都不变即为缓存帧 |
| `ageMs` | 宿主单调时钟算出的帧龄；判断「采集停滞」而不是「界面没刷新」 |
| `captureState` | `idle` / `starting` / `capturing` / `error` |
| `analysisMode` | `numpy-fft`（真实分频）或 `level-only`（依赖降级） |
| `device` | 真实采集目标：`{ mode, name, defaultName, index, isDefault }` |
| `level.bands` | 8 段带内 RMS，1.0 ≈ 满量程正弦在该段的 RMS |

数值语义：`rms` 是全部声道的均方根；`bands` 是各段的带内 RMS——**满量程正弦落在任意一段内都读到约 0.707**，和 `rms` 同一标尺。声道能量在频谱之后合并，所以左右反相的立体声不会被算成静音。

### 租约与多窗口

- 每个窗口启用时用 `clientId` 申请租约（默认 90 秒，宿主限制在 15–240 秒），轮询会顺带续约。
- 最后一个租约释放后助手才停止；关掉一个窗口不会影响其他窗口。
- 窗口隐藏时停止绘制与轮询，租约自然过期（不需要关闭通知必达）；重新可见时重新申请。
- 页面真正关闭时用 `sendBeacon` 通知宿主立刻释放；进入往返缓存（bfcache）不算关闭。
- 兜底：10 分钟完全没有客户端时宿主自行停止助手。

### 退出与错误处理

- 宿主先向助手 stdin 写 `stop`，等 1.5 秒仍未退出才强杀；助手在 stdin EOF 时也会自行退出。
- 依赖探测失败、设备不可用、采集停滞会分别显示在设置页，并提供「重新安装依赖」入口，而不是反复空转。
- 采集停滞（帧龄超过 2.5 秒且没有新帧）会显示「采集已停滞」并按 0.4 秒 → 12 秒退避重启助手；传输失败另外按 0.5 秒 → 12 秒退避。

## 开发与验证

```powershell
# 离线测试（不需要音频设备，也不碰真实 DSH）
node _tests\host.test.mjs      # 宿主路由、租约、协议、安装任务、鉴权与脱敏
node _tests\client.test.mjs    # 浏览器半状态机、DOM 身份缓存、平滑、配置校验
python _tests\audio.test.py    # 音频分析（合成 PCM：同相/反相/单声道/多频段/DC/静音）

# 打开 dev/demo.html 可离线预览动效（?mode=stale 看陈旧帧、?marks=2 看少轮次映射）
# Windows PowerShell 自检（对着真实 DSH 跑）
powershell -ExecutionPolicy Bypass -File verify.ps1
powershell -ExecutionPolicy Bypass -File verify.ps1 -Tone   # 播放测试音并检查是否抓到信号
```

`_tests/audio.test.py` 在装有 NumPy 与未装 NumPy 的解释器下都可以运行，用来确认两种分析模式的行为一致。

打包：

```powershell
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" pack --pack-destination .
```

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 租约、HTTP 接口、依赖安装与探测、助手进程生命周期 |
| `lib/audio-levels.py` | 捕获系统输出，计算 RMS、峰值和 8 个频段 |
| `lib/client.js` | 设置界面、状态机、导航栏动效 |
| `cordis.patch.yml` | 插件挂载配置 |
| `verify.ps1` | 端到端自检（按唯一帧统计） |

## 注意事项

- **仅支持 Windows**；macOS / Linux 暂无音频后端。
- 数值是相对电平，适合展示律动，**不是**校准过的响度计（dBFS、LUFS、声压是不同量）。
- WASAPI loopback 采集的是所选输出端点的混音；受保护内容（DRM）和部分音频模式可能无法捕获。
- 导航栏定位依赖 DSH 的 DOM 与 CSS 类名，界面大改后可能需要适配；此时设置页仍可用，并会提示当前会话没有轮次导航栏。
- 本地 `/volume-bar/*` 接口默认只接受 loopback 的 Host 与同源/本机 Origin，且只上报去标识化的诊断信息（版本、刻度数、分析模式，不含完整 URL）；它仍然没有独立的鉴权，本机其他进程可以调用。
- 助手只做本地实时计算，**不保存也不上传任何音频**。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-volume-bar
```

重启 DSH 后生效。可手动删除 `~/.dsh/tools/dsh-volume-bar` 中的依赖环境。

## 变更

### 0.7.1

- 设置页改为与 DSH 内置分区一致的注册方式（直接注册组件，不再依赖嵌套槽位），兼容 0.2.1 版设置外壳。
- 设置页行顺序与设计稿对齐：灵敏度 → 动效幅度 → 响应速度 → 动效预设 → 试听预览 → 采集设备 → 诊断信息 → 恢复默认。
- 「诊断信息」改为行式折叠标题（右侧箭头），与其它行对齐。

### 0.7.0

针对 0.6.0 评审（F01–F20）的稳定性与体验改进：

- **启停**：用「用户意图 + 运行代次」驱动，首次启动失败也会持续恢复；关闭或卸载后迟到的响应不会再打开动效。
- **陈旧数据**：按 `generation`/`seq` 判断新帧，配合 `ageMs` 区分「健康静音」「采集停滞」「宿主离线」，停滞会自动重启助手并显示原因。
- **会话切换**：刻度缓存改为按节点身份校验，同轮次数的会话切换也能驱动新节点。
- **多窗口**：改为会话租约，最后一个消费者离开才停止采集。
- **依赖**：真实健康探测（导入模块 + 枚举设备），安装任务共享并有超时，支持强制修复。
- **音频**：逐声道合并能量（反相不再变静音）、频段改为带内 RMS（满量程正弦约 0.707）、窗口 2048/步长 1024、无 NumPy 时明确降级为总电平模式。
- **界面**：平滑按真实时间计算（刷新率无关）、动效预设、无需采集的试听预览、设备选择、可访问名称与焦点样式、`prefers-reduced-motion` 支持。
- **协议**：v2（`protocolVersion`/`generation`/`seq`/`ageMs`/`captureState`/`analysisMode`/`device`），宿主只上报去标识化的客户端信息。
- **自检**：`verify.ps1` 按唯一帧统计、检查帧龄与分析模式、持有并释放自己的租约、用 `finally` 清理临时文件。

### 0.6.0

宿主掉线、插件被重载、窗口长时间在后台时自动重连，不再静默失效。

## License

MIT
