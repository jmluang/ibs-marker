# 仅内网预览（非公网部署）

```sh
cd /home/luang/ibs-marker
npm run build
npm run preview:lan
```

访问 `http://10.21.1.227:5217`。仅监听主机的这个精确 IPv4 地址，不监听 `0.0.0.0`、IPv6 全接口、Tailscale 或 Docker 接口；现有 `127.0.0.1:5217` 预览可以同时运行。端口占用或该 IP 不存在时启动失败，不自动换端口。地址变更须先核实网卡地址，再明确修改脚本，不要用通配绑定代替。

所有 HTTP 请求（首页、SPA 路由、静态 assets、SW 等）先按 `req.socket.remoteAddress` 检查，仅允许 `10.21.1.0/24`，支持 IPv4-mapped IPv6 地址形式；其余返回 403。Host、X-Forwarded-For、Forwarded 等请求头不参与授权。不配置反向代理，不改系统防火墙/路由/其它服务，不需要 sudo、Docker 提权或新依赖。不做公网端口映射、隧道转发或公网部署。

## HTTP 能用什么、不能用什么

普通 LAN HTTP **不是 secure context**。记录、草稿、计时和本机 IndexedDB 可用；UUID 优先原生 `crypto.randomUUID`，缺少时用 `crypto.getRandomValues` 生成带正确版本/variant 位的 v4 UUID，不使用 `Math.random`，无密码学随机源则明确失败。此兼容修复不会把 HTTP 变成 HTTPS。

Service Worker / 离线 PWA 和系统通知等安全上下文能力仍需要受信任 HTTPS；HTTP LAN 不保证安装、离线启动或通知。需要这些能力时应另行配置可信证书和 HTTPS，并重新验收；不要禁用浏览器安全检查。

## 账号与隐私

ACL 限制的是网络来源，不是用户身份认证。获准网段内的任何设备都能加载页面；不要认为它等同加密或可信用户。HTTP 页面和其 JS 可被网络中间人篡改，即使账号请求本身使用 HTTPS 也不能消除这一风险。建议此预览仅用本机模式和合成测试资料；不要在此 HTTP 预览输入真实账号密码或敏感健康资料。真实云登录/跨设备同步须单独验收，本文不声称已验证云服务。

LAN origin 与 localhost origin 的浏览器存储相互独立，不会自动迁移记录。共享设备要留意浏览器里的本机记录/账号缓存；清理浏览器数据可能丢失本机记录。

## 验证与回滚

- `npm test`、`npm run typecheck`、`npm run build`。
- `ss -ltnp '( sport = :5217 )'` 确认只出现精确 LAN IP 和原有回环监听。
- `curl --noproxy '*' http://10.21.1.227:5217/` 应为 200。
- `curl --noproxy '*' --interface 127.0.0.1 -i http://10.21.1.227:5217/` 应为 403；伪造 `-H 'X-Forwarded-For: 10.21.1.2'` 或请求 assets 也应为 403。本机 Tailscale 源 `100.109.89.118` 亦已验证 403。
- **本机网络改写注意**：2026-10-20 实测 `--interface 172.17.0.1` / `172.22.0.1` 的连接抵达 Node 时，`req.socket.remoteAddress` 已是 `10.21.1.227`，因此返回 200；这不是可用于断言拒绝的原始来源样本。socket ACL 不能恢复被上游 NAT/代理丢失的原地址，更不能依赖 XFF 来“修复”。本方案未改动导致源地址改写的系统配置；需要物理网段之外的严格端到端隔离时，应由管理员另行检查现有转发/NAT/代理，不能把应用层 ACL 当成防火墙。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node scripts/verify-lan.mjs /path/to/evidence` 可启动临时 LAN 预览，执行真实 HTTP 与隔离浏览器合成验收，完成后自动关闭。此脚本要求本机已存在用于拒绝测试的 Tailscale 地址；不会安装浏览器或修改网络。
- 使用独立浏览器测试上下文验证真实 HTTP 下 `isSecureContext === false`、`crypto.randomUUID` 缺失，并验证三类保存、计时结束保存及刷新持久化；不要用真实资料测试。
- 回滚/停止：前台按 Ctrl-C；若作为进程运行，只给此次 LAN 脚本的准确 PID 发 TERM，不要用 `pkill node` 或杀掉原有回环预览。随后用 `ss` 确认 `10.21.1.227:5217` 已消失且原有监听仍在。未修改全局网络规则，因此没有防火墙回滚动作。
