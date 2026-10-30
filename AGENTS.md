# AGENTS.md — 本仓库的 agent 工作约定

面向在这个仓库里干活的 agent（含 DSH 里跑的会话）。规则只约束本仓库；
与用户当次明确指令冲突时，以用户指令为准。

---

## 1. 每次改动后立即提交（硬规则）

**触发**：只要动了仓库里的文件（`lib/`、`test/`、`scripts/`、`cordis.patch.yml`、
`package.json`、`README*`、`CHANGELOG.md`），验证通过后**立刻 commit**，
不要等用户说「提交」、也不要攒到一轮结束再一起提。

**粒度**：一个逻辑改动一个 commit。改两件事就提两次；同一个 feature 的多个文件可以一起提。

**格式**：Conventional Commits，标题 <72 字符，正文写清「为什么」：

```
<type>(<scope>): <一句话说清做了什么>

- 改了什么（文件 / 行为）
- 为什么（触发的问题或需求）
- 验证方式（跑了什么命令、结果如何）
```

`type` 只用：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `chore`。
`scope` 常用：`host`（`lib/git.mjs`、`lib/format.mjs`、`lib/index.js`）、`api`（`lib/api.mjs`
与路由）、`panel`（`lib/client.js`）、`scripts`、`test`、`docs`、`release`（版本号 + CHANGELOG）。

**提交前必做**：

1. `npm test` 必须绿（= `node --test "test/*.test.mjs"`，22 项，约 25 秒；只改文档可跳过，但 commit 里要写明跳过原因）。
2. `git status --short` 看一眼改动清单。
3. **只 `git add` 自己动过的文件**，不要 `git add -A` / `git add .`——
   本机可能有并发会话在同一仓库里改东西（例如面板改动尚未提交），
   全量 add 会把别人的半成品裹进你的提交。

**明确不做**：

- 不 `git push`。仓库推到 GitHub 是公开的对外动作，等用户明确要求再推。
- 不改写已推送的历史：不 `--amend` 已 push 的 commit、不 `force push`。
- 不提交产物与依赖：`node_modules`、`*.tgz`、`.env`、凭据（`.gitignore` 已覆盖，别绕开）。
- 不加运行时依赖：本包**零依赖、零构建**，`dsh` 与 `@deepseek-ai/dsh-tools` 由宿主提供
  （测试用 `test/stub/loader.mjs` 把前者指到 stub）。确实要加依赖，先问用户。

---

## 2. 不要用 checkout/reset 清工作区

`git checkout -- <file>`、`git reset --hard` 会**直接抹掉未提交改动**，且不可恢复。
要丢弃某处改动时：先把文件复制到仓库外备份，或 `git stash push -- <file>`，再改；
不确定就留着别动。

（教训：2026-10-28 在同类仓库里一次 `git checkout -- web/index.html` 抹掉了 220 行未提交改动。）

这条对**插件自身的行为**同样成立：见第 5 节。

---

## 3. 改完先自检，再提交

| 改了什么 | 最低自检 |
|---|---|
| `lib/git.mjs`、`lib/format.mjs`（host 半） | `npm test`；必要时 `node scripts/smoke.mjs` 看三张表的实际输出 |
| `lib/api.mjs`、`lib/store.mjs`、`lib/state.mjs`、`lib/workspaces.mjs`、`lib/suggest.mjs` | `node scripts/smoke-panel.mjs`（临时仓 + fake model，跑完 workspaces → managed → state → stage → suggest → commit） |
| `lib/client.js`（面板 UI） | 重启 dsh（桌面 App 从托盘 Quit 再启动），打开侧栏 workaround-git 页，把四类动作点一遍；client 半是纯 JS，**没有构建步骤** |
| `lib/index.js`（插件装配 / 配置） | 重启后确认五个 `git_workspace_*` 工具与面板页都还在，再跑 `npm test` |
| `scripts/*.mjs` | 直接跑那个脚本 |
| 只改文档 | 人工过一遍；可跳过测试 |

面板联调走桌面 profile 的 `link:` 依赖（junction 指向本 checkout，重启即生效），
步骤见 `README.md` 的 “Develop against the running desktop app”，不要在仓库里另建构建链。

---

## 4. 行为变化要进 CHANGELOG

- 用户可见的行为变化 → 在 `CHANGELOG.md` 的 `[Unreleased]` 下补一条（`Added` / `Changed` / `Fixed` / `Removed`），一句话说清变化本身。
- 版本号只在用户要求发版时动：`package.json` 的 `version`、把 `[Unreleased]` 收成带日期的版本段、补对比链接。
- 文档事实以 `README.md`（英文主文档）为准。`README.zh-CN.md` 目前停在 0.1 内容、
  还没跟上面板和卡片视图：改功能描述时别照着它改，也别只补一句就当成同步已做完；
  要补中文版就整篇补。

---

## 5. 红线：插件的 git 行为

仓库本身就是一个批量 git 工具，所以下面几条是产品约束，不是风格偏好：

- 不给插件加 `checkout --`、`reset --hard`、`push --force`、历史改写。`git_workspace_sync` 只 `--ff-only`（用户显式要 `rebase` / `merge` 才换）。
- `git_workspace_commit` 必须有 message：`messages` 必填、空串拒绝、对不上任何 repo label 的 key 报错而不是静默丢弃；没有条目的仓库跳过。
- 脏工作区不 sync：跳过并在结果里写原因；跳过不算失败。
- 读操作（`status` / `changes`）不写盘；`sync` / `commit` / `push` 保持 `dryRun`，且 sync 的 dry run 仍要 fetch（否则预览会说谎）。
- `root` 限定在会话工作区内，`allowOutsideRoot: true` 才放宽；面板侧 `repo` 必须解析到 managed workspace 内。
- 每个 per-repo 操作返回 result 对象、不 reject：部分失败是表里一行，不中断整批。

---

## 6. 提交示例

```bash
git add lib/api.mjs lib/index.js CHANGELOG.md package.json
git commit -m "fix(api): 面板路由改由 ctx.inject(['webServer']) 挂载

- apply() 阶段 get('webServer') 拿不到服务（Loader 并发挂载 entry）
- 路由落到 SPA fallback，面板报 HTTP 404: response is not JSON
- 验证：npm test 22 项绿；node scripts/smoke-panel.mjs 通过"

git add lib/client.js README.md CHANGELOG.md package.json
git commit -m "feat(panel): 卡片条改单行横排，超出时横向滚动

- 卡片不再换行到第二行；宽面板固定显示四张，其余用滚轮 / ‹ › 滚动
- 验证：重启桌面 App 手点面板；node scripts/smoke-panel.mjs 通过"
```
