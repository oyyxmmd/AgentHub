# AgentHub 反代网关 · Docker 部署指南

把 AgentHub 的反代网关跑在容器里：与桌面版共享同一份渠道代码，7×24 无人值守转发
OpenAI / Anthropic / Responses 三协议，自带 Web 控制台与管理 REST API。

---

## 一、能力边界（部署前先读）

| 能做 | 不能做 |
|---|---|
| 三协议转发（14 个渠道，与桌面版同一套适配器） | 本机软件导入账号（容器里没有桌面客户端） |
| 号池调度：轮换 / 冷却 / 熔断 / 成本路由 | IDE 切号（写回本机客户端登录文件） |
| 定时签到、额度自动刷新、号池定时同步 | 人机校验弹窗（ZCode 领取需人工，走桌面版） |
| 管理 API：Key / 账号 / 渠道 / 配置 / 备份 | Qoder 双区（需要 Windows 客户端 wasm 签名，容器内必然失败，已默认禁用） |
| WebDAV/S3 号池跨形态同步（与桌面版互通） | 与桌面版共用同一个数据目录（凭据信封不兼容，见 §5.4） |

**账号从哪来**（容器是空壳，必须先灌号）：
1. **WebDAV/S3 号池同步**（推荐）：与桌面版配同一个服务器，号池双向同步，见 §6.1；
2. **JSON 导入**：桌面版导出的快照或手工凭据，走管理 API，见 §6.2。

---

## 二、快速开始

前置：Docker 20.10+ 与 Compose v2；Linux 服务器建议 1 核 512MB 起。

```bash
# 1) 生成凭据加密密钥（丢失后已加密的凭据不可恢复，务必留存好）
export AGENTHUB_SECRET_KEY=$(openssl rand -base64 32)

# 2) 准备数据目录（容器内以 uid 1000 运行，宿主目录属主必须对齐）
mkdir -p gateway-data && sudo chown 1000:1000 gateway-data

# 3) 构建并启动（在仓库根执行）
docker compose -f gateway/docker-compose.yml up -d --build
```

验证：

```bash
docker compose -f gateway/docker-compose.yml ps          # STATUS 应为 healthy
curl -s http://127.0.0.1:9528/api/livez                  # {"ok":true}  进程存活
curl -s http://127.0.0.1:9528/api/readyz                 # 503 = 还没账号（预期），灌号后转 200
curl -s http://127.0.0.1:9528/api/status                 # 版本 / 平台 / 加密方式 / 数据目录
```

给下游客户端配置：Base URL `http://<服务器>:9527/v1`，API Key 在 Web 控制台里建（见 §4.5）。

浏览器打开 `http://<服务器>:9528/` 即 Web 控制台——注意它默认只绑宿主回环，从外部访问前
需要设置 `AGENTHUB_ADMIN_TOKEN`（登录时输入该令牌，见 §4.4）。

---

## 三、环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `AGENTHUB_SECRET_KEY` | **是** | — | 凭据加密密钥（AES-256-GCM）。未设置时容器拒绝启动；丢失后需靠号池重新同步恢复（§8） |
| `AGENTHUB_ADMIN_TOKEN` | 否 | 空 | 管理 API 鉴权令牌。未设置时管理面只绑容器回环（容器外不可达） |
| `AGENTHUB_ADMIN_READONLY_TOKEN` | 否 | 空 | 只读令牌：只能看不能改（日常监视/看板专用）。设了任一令牌管理面即绑 0.0.0.0 |
| `AGENTHUB_PROXY_PORT` | 否 | 9527 | 反代网关端口（容器内外一致） |
| `AGENTHUB_ADMIN_PORT` | 否 | 9528 | 管理 API 端口 |
| `AGENTHUB_HOST` | 否 | 0.0.0.0 | 反代网关监听地址（容器内） |
| `AGENTHUB_ADMIN_HOST` | 否 | 按 token | 管理面监听地址；默认有 token 为 0.0.0.0、无 token 为 127.0.0.1 |
| `AGENTHUB_ALLOW_PLAINTEXT` | 否 | — | 设 `1` 允许无密钥明文存储凭据（**仅本地调试**） |
| `TZ` | 否 | Asia/Shanghai | 业务时区：签到时刻与日额度重置都按它计算 |

---

## 四、端口与网络

### 4.1 端口占用

| 端口 | 用途 | 暴露范围 |
|---|---|---|
| 9527 | 反代网关（客户端连这个） | 需要被下游客户端访问 |
| 9528 | Web 控制台 + 管理 API（同源） | 默认只绑宿主 `127.0.0.1` |

### 4.5 Web 控制台

浏览器打开 `http://<服务器>:9528/`，用 `AGENTHUB_ADMIN_TOKEN` 登录（前端静态资源无需凭据，
全部 `/api` 操作需令牌）。可管理号池、Key、渠道启停、用量与操作日志；桌面专属能力
（启停网关、IDE 切号、打开目录、本机导入等）在容器里不可用，界面上会给出原因与替代路径。

控制台与 API 同源同端口（前端 CSP 只允许同源请求，这也是不拆端口的硬约束）；反向代理把
9528 作为一个整体转发即可，无需区分路径——静态资源走 `/`，接口走 `/api/*`。

页面状态刷新走 SSE（`GET /api/events`，需令牌）：事件信封与桌面版完全同形，断线自动重连；
浏览器控制台与桌面版的远程连接共用同一套刷新逻辑。

### 4.2 改端口

```bash
# .env（与 compose 同目录）或直接 export
AGENTHUB_PROXY_PORT=19527
AGENTHUB_ADMIN_PORT=19528
```

compose 的端口映射与容器内监听都用这两个变量，改一处即可。若只想改**映射到宿主的端口**
而容器内不变，编辑 compose 的 `ports:` 左侧（如 `"19527:9527"`）。

### 4.3 客户端接入

- **同机**：`http://127.0.0.1:9527/v1`
- **局域网**：`http://<服务器IP>:9527/v1`（确认宿主防火墙放行 9527）
- **跨互联网**：强烈建议在其前面加一层带 TLS 的反向代理（Nginx/Caddy），反代端口对外只开 443

### 4.4 管理面的访问控制

三层，按需递进：

1. **默认（不设 token）**：管理面只绑容器回环，宿主上也访问不到——只能 `docker exec` 进容器操作；
2. **设 token + 宿主回环映射**（推荐）：
   ```bash
   AGENTHUB_ADMIN_TOKEN=$(openssl rand -hex 24)
   # 宿主上访问：curl -H "Authorization: Bearer $AGENTHUB_ADMIN_TOKEN" http://127.0.0.1:9528/api/status
   ```
3. **远程管理**：把管理端口交给带 TLS 的反向代理，并保留 token 鉴权。

管理 token 与下发给客户端的 `sk-` Key 是**两套凭据**，不要混用。

**只读令牌**（可选）：设 `AGENTHUB_ADMIN_READONLY_TOKEN` 后，该令牌只能执行监视类命令与查询
端点（写操作返回 403）——适合放进看板、监控脚本或桌面版的日常监视连接，全权令牌只留在需要
动手操作的地方。

---

## 五、存储卷

### 5.1 目录与权限

compose 把宿主的 `../gateway-data` 挂到容器 `/data`。容器以非 root（uid 1000）运行，
宿主目录属主必须是 1000：

```bash
mkdir -p gateway-data && sudo chown -R 1000:1000 gateway-data
```

### 5.2 目录内容

```
gateway-data/
├── config.json     网关配置（WebDAV 凭据以 enc:v2: 密文存储）
├── proxy/
│   ├── stats.db    号池 / Key / 用量（WAL 模式）
│   └── rules/     渠道规则
└── gateway.lock    单实例锁（进程退出自动清理；强杀残留会被下次启动接管）
```

**同一份数据目录只允许一个网关进程**：本机重复启动会被锁拒绝（报出占用 pid）；
两个容器挂同一个卷属于误配置，不要这么做。

### 5.3 备份与恢复

**在线备份**（推荐，不停机）：

```bash
curl -H "Authorization: Bearer $AGENTHUB_ADMIN_TOKEN" \
     -o stats-backup-$(date +%F).db http://127.0.0.1:9528/api/backup
```

产物是 `VACUUM INTO` 出来的一致性快照（单文件、无 WAL 残留），可直接用 SQLite 工具打开。

**全量备份**（含配置与规则）：停容器后整目录打包即可（`config.json` 是原子写、`stats.db` 停容器后
已 checkpoint）：

```bash
docker compose -f gateway/docker-compose.yml stop
tar czf gateway-data-$(date +%F).tgz -C . gateway-data
docker compose -f gateway/docker-compose.yml start
```

**恢复**：停容器 → 清空 `gateway-data/proxy/stats.db*`（含 `-wal`/`-shm`）→ 放入备份文件并改名 `stats.db`
→ 起容器。**密钥必须与备份时一致**，否则库里的 `enc:v2:` 凭据解不开（§8）。

### 5.4 为什么不能与桌面版共用数据目录

桌面版的凭据用系统密钥（safeStorage/DPAPI）加密，**只在那台机器的那个用户下能解开**；
容器（Linux）读到的会是解不开的密文，账号会显示"存在但没有 token"，转发必然失败——而且是静默的。
两种形态之间传号只走 §6.1 的号池同步通道。

---

## 六、账号从哪来

### 6.1 WebDAV/S3 号池同步（推荐）

与桌面版（或另一台机器的桌面版）配置同一个 WebDAV/S3 服务器，号池自动双向同步：
账号、凭据、余额、删除墓碑都会传播；**凭据在传输包里是加密的，到对端后用本机机制重新加密落库**。

```bash
curl -X PUT http://127.0.0.1:9528/api/config/webdav \
  -H "Authorization: Bearer $AGENTHUB_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"webdav","endpoint":"https://dav.example.com/dav","username":"me","password":"******"}'
```

要点：
- 与桌面版**同 endpoint / 同 username / 同密码**，否则两边互相看不到；
- 号池加密口令（若桌面版设置过）也在这里一起传：`"encryptionPassphrase":"..."`；
- 写入后最多等一个同步周期（或重启容器）即可在 `/api/accounts` 看到账号；
- 桌面版每次启动会自动同步；Docker 侧按周期自动拉取，无需手工触发。

### 6.2 JSON 导入

```bash
# 桌面版导出的号池快照，或手工凭据（单条/数组均可）
curl -X POST http://127.0.0.1:9528/api/accounts/import \
  -H "Authorization: Bearer $AGENTHUB_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"modelscope","accounts":[{"uid":"u1","name":"我的号","token":"..."}]}'
```

### 6.3 与桌面版协同的分工

- **登录/扫码/本机导入**：在桌面版做（OAuth 回调、设备码、客户端登录态都在那边）；
- **人机校验**（ZCode 领奖）：在桌面版号池页手动过码，Docker 侧自动签到遇到需要过码的行会如实标记；
- **号池**：两边经 §6.1 同步后都有；哪边重新登录过，凭据按"有效性优先 + 时间新者胜"仲裁。

---

## 七、【重点场景】WebDAV 与 Docker 跑在同一台服务器

很常见的部署：同一台服务器上既跑 WebDAV（群晖/AList/Nginx-DAV 等），又跑本网关容器。

```
┌─ 服务器（192.168.1.10）────────────────────────────┐
│  WebDAV 服务（宿主，监听 :5005 或 :443）           │
│  ┌─ Docker ──────────────────────────────┐        │
│  │  agenthub-gateway 容器                 │        │
│  │  webdavShared.endpoint 指向 ???        │        │
│  └────────────────────────────────────────┘        │
└────────────────────────────────────────────────────┘
```

### 7.1 endpoint 到底填什么

**容器里的 `127.0.0.1` 是容器自己，不是宿主**——填 `http://127.0.0.1:5005/...` 一定连不上
（错误长这样：`ECONNREFUSED 127.0.0.1:5005`）。三种正确写法：

| 写法 | 适用 | 示例 |
|---|---|---|
| **宿主的局域网 IP / 域名**（最通用，推荐） | 所有平台 | `http://192.168.1.10:5005/dav` |
| `host.docker.internal` | Docker Desktop（Windows/macOS）内建；Linux 需 compose 加 `extra_hosts` | `http://host.docker.internal:5005/dav` |
| 走宿主上已有的反向代理域名 | 同机有 Nginx/Caddy 统一入口 | `https://dav.example.com/dav` |

Linux 宿主用 `host.docker.internal` 时，在 compose 的 service 下加：

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### 7.2 端口冲突排查

WebDAV 常用 80/443/5005/5006，与本网关的 9527/9528 天然不冲突。真正要留意两种情况：

1. **WebDAV 的反向代理拿走了 9527**：把网关端口改掉（§4.2），管理端口同理；
2. **宿主已有服务占了 9528**：`ssh` 上去 `ss -lntp | grep 9528` 确认后换端口；容器内的端口不变时，
   只改 compose `ports:` 左侧即可（如 `"127.0.0.1:19528:9528"`）。

### 7.3 网络模式

保持默认 bridge + 端口映射即可：
- 容器出站访问宿主 WebDAV / 各家上游：走宿主网络，无需额外配置；
- 入站只有你显式映射的两个端口；
- 不建议 `network_mode: host`（管理面会直接暴露在所有网卡上，失去默认的隔离）。

### 7.4 TLS 与证书

- 容器内置 `ca-certificates`，公网证书（Let's Encrypt 等）直接可用；
- **自签证书**：默认会握手失败（`self-signed certificate`）。两种做法：
  - 把自签 CA 挂进容器并更新信任库（需要构建自定义镜像或在 compose 里挂载 + 启动脚本执行
    `update-ca-certificates`）；
  - 或在内网直接用 `http://<宿主IP>:<端口>`（WebDAV 在内网、或前面有反代时可接受）。

---

## 八、密钥管理（AGENTHUB_SECRET_KEY）

- **作用**：容器里没有系统钥匙串，号池 token、WebDAV 密码等一律用它派生的 AES-256-GCM 密钥加密落盘
  （前缀 `enc:v2:`）。不设置时容器**拒绝启动**，不存在"悄悄明文存"。
- **生成**：`openssl rand -base64 32`；注入方式：环境变量文件（`.env`）、Docker secret、或编排平台的
  secret 机制。**不要**写进 compose 明文提交到仓库。
- **丢失的后果**：`enc:v2:` 密文不可恢复（AES-GCM 无后门）。但**号池可以重建**：把
  `AGENTHUB_SECRET_KEY` 换成新值（或重建容器）→ 停容器删 `stats.db` → 起容器 →
  用同一个 WebDAV 服务器重新同步号池（§6.1）。桌面版或其他设备上的号池是完整的副本。
  **配置密码（WebDAV）需要重新填写一次**。
- **轮换**：暂不支持在线轮换。标准流程 = 备份 → 新密钥重建（同上）→ 重新同步。

---

## 九、升级与回滚

```bash
# 升级（拿到新代码后）
git pull && docker compose -f gateway/docker-compose.yml up -d --build

# 回滚到上一个镜像
docker compose -f gateway/docker-compose.yml down        # 注意：不要加 -v（会删卷）
# 改 compose 里 image 为一个已保存的旧 tag，或直接 rebuld 到旧提交
docker compose -f gateway/docker-compose.yml up -d
```

上线前例行：备份（§5.3）→ 记录当前镜像 tag 与 `git rev-parse HEAD` → 升级 → 看
`/api/livez`、`/api/channels`、日志。

数据兼容：`stats.db` 的结构迁移是单向的（升级自动迁移，降级不保证能读），跨大版本回滚前先验证。

---

## 十、排障

| 症状 | 原因 / 处理 |
|---|---|
| 启动即退出，日志"拒绝启动：未设置 AGENTHUB_SECRET_KEY" | 设置密钥（§8）；仅本地调试可 `AGENTHUB_ALLOW_PLAINTEXT=1` |
| 日志"数据目录已被本机 pid N 占用" | 已有实例在跑（`docker ps` / 宿主进程）；确认后停掉旧实例 |
| 容器 STATUS 一直 `unhealthy` | 检查 `docker logs`；健康检查打 `/api/livez`（进程存活），若这条都失败说明进程已崩 |
| `/api/readyz` 恒 503 | 空池（还没灌号）或全部账号在冷却；先看 `/api/channels` 的池状态 |
| 请求 503 且提示渠道不可用 | 该渠道无在线账号或全部冷却；用管理 API 查号池 |
| WebDAV 同步报连接失败 | 见 §7.1（十有八九是 endpoint 填了 `127.0.0.1`） |
| WebDAV 同步报证书错误 | 自签证书，见 §7.4 |
| 签到没在预期时间执行 | 容器 `TZ` 是否对（§3）；签到时刻按容器本地时间计算 |
| 上游全部 401 | 凭据失效：桌面版重新登录该账号，号池同步过来 |

常用命令：

```bash
docker compose -f gateway/docker-compose.yml logs -f --tail=200
docker exec agenthub-gateway date            # 验证时区
docker exec agenthub-gateway id -u           # 应为 1000
```

---

## 十一、启动后安全清单

- [ ] `AGENTHUB_SECRET_KEY` 已设置且妥善留存（密码管理器/secret 管理）
- [ ] 管理 API 已设 `AGENTHUB_ADMIN_TOKEN`，或确认管理端口未映射到公网
- [ ] 9528 在宿主只绑 `127.0.0.1`（compose 默认如此）
- [ ] 对外暴露 9527 时前置了 TLS 反向代理
- [ ] `gateway-data` 属主为 1000:1000，且已在备份计划内
- [ ] 定期验证 `/api/backup` 可用（§5.3）
