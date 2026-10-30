# dsh-workaround-git

DeepSeek Harness（dsh）插件：对整个工作区的所有仓库做批量 git 操作 —— 一张状态总览、一次同步、每个仓库各写各的提交信息、一次推送。

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.3-4B32C3?style=flat-square" alt="dsh engines">
  <img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/tools-5-black?style=flat-square" alt="Tools">
</p>

[English](./README.md)

## 为什么需要它

工作区分成多个项目、并行开发时，同一组 git 命令要在 N 个终端里重复 N 次。模型可以一个个跑，但很慢，看不见其他仓库的状态，批量的结果也没有一个统一的落点。

这个插件给模型五个动词，一次作用于整个工作区，每个动词返回一张表：改了什么、差多少、哪个失败、为什么。

## 特性

- **自动发现，不用配置。** 工作区根目录下每个 `.git` 就是一个项目。没有仓库清单要维护，也不会和实际目录脱节。
- **一屏看全。** 分支、工作区脏状态、相对 upstream 的 ahead/behind、最后一次提交，合并在一张表里。
- **同步不猜。** 先 fetch 再 fast-forward；工作区脏的仓库直接跳过并写明原因，而不是把冲突半解开留在那里。
- **每个仓库一条提交信息。** `git_workspace_changes` 把每个仓库自己的 diff 交给模型，`git_workspace_commit` 接收「仓库 → 提交信息」的映射，全工作区提交不会共用一条信息。
- **部分成功是常态。** 失败的仓库只占表里一行，不会中断整批。
- **写之前可演练。** `sync`、`commit`、`push` 都支持 `dryRun`。
- **零依赖、零构建。** 纯 ESM，不需要 `npm install` 就能被加载。

## 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `git_workspace_status` | 全部仓库的状态表：分支、脏状态、ahead/behind、最后提交 | `root?`、`maxDepth?` |
| `git_workspace_sync` | 逐仓库 `fetch` + fast-forward；脏工作区跳过 | `root?`、`maxDepth?`、`mode?`、`dryRun?` |
| `git_workspace_changes` | 每个仓库的 diff 摘要，用于写提交信息 | `root?`、`maxDepth?` |
| `git_workspace_commit` | 一次提交多个仓库，每个仓库用自己的信息 | `messages`（必填）、`root?`、`maxDepth?`、`dryRun?` |
| `git_workspace_push` | 逐仓库推送当前分支；首次推送自动设置 upstream | `root?`、`maxDepth?`、`dryRun?` |

`root` 缺省时取当前会话的工作区目录，再退回进程当前目录。

## 安装

需要 Node `^22.19.0 || >=24.0.0`、dsh `>= 0.2.1-rc.3`，以及 `PATH` 里有 `git`。

```bash
# 从本地检出安装（现在就能用）
dsh plugin --profile web add /path/to/dsh-workaround-git

# 仓库推到 GitHub 之后
dsh plugin --profile web add github:Roshenn/dsh-workaround-git#v0.1.0

# 发布到 npm 之后
npx -y @deepseek-ai/dsh plugin --profile web add dsh-workaround-git@0.1.0
```

然后重启 `dsh web`。`dsh plugin` 会把参数转给 pnpm、装进 profile 的 `package.json`；本包的 `dsh.bundle.patch` 挂载 `cordis.patch.yml`，把插件行插入插件树。

确认插件行已生效：

```bash
dsh --profile web --dump-config | grep workaround-git
```

**桌面端：** `desktop` profile 由 Electron 外壳管理，CLI 会拒绝操作它。请在应用里打开 **Plugins → Add plugin**。

## 配置

默认值写在 `cordis.patch.yml`，可以直接改：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxDepth` | `3` | 在根目录下向下查找 `.git` 的最大深度 |
| `concurrency` | `4` | 并行处理的仓库数 |
| `pullMode` | `ff-only` | `git_workspace_sync` 的默认整合方式：`ff-only`、`rebase` 或 `merge` |
| `allowOutsideRoot` | `false` | 允许 `root` 超出会话工作区（见「安全边界」） |

patch 加载器会整体替换 `config`，不做深合并 —— 需要几个字段就写全几个字段。

## 用法

不需要自己调工具，在对话里说就行，模型会挑。

**先看现状：**
> 现在这个工作区里各个仓库是什么状态？

**开工前先同步：**
> 把能安全同步的都同步一遍，然后告诉我哪些被跳过、为什么。

**两步提交：**
> 看看每个仓库改了什么，按各自的 diff 分别写提交信息，然后提交。

模型会先调 `git_workspace_changes`，读到每个仓库的文件与行数，逐个写信息，再以映射形式传回：

```json
{
  "messages": {
    "api-server": "fix(auth): 在 token 过期前刷新而不是过期后",
    "web-client": "feat(settings): 账号区块上移到计费之上"
  }
}
```

`messages` 里没有的仓库会被跳过 —— 绝不会套用别人的提交信息。key 必须是 `git_workspace_changes` 显示的精确 label（或绝对路径）；一旦 label 存在嵌套（`apps/api-server` 与 `libs/api-server` 都叫 `api-server`），裸目录名不够用，匹配不上的 key 会让整次调用报失败，而不是被悄悄丢掉。

**批量推送：**
> 把刚提交的仓库都推了。

## 输出示例

五仓库工作区上执行 `git_workspace_sync` 的 dry run —— 会先 fetch 以保证预览准确，然后停在整合之前：

```
**sync** · 5 repos · up-to-date: 3, would-sync: 1, skipped: 1

| repo | action | status | after | detail |
| --- | --- | --- | --- | --- |
| app | up-to-date | ok | ↑0 ↓0 | already up to date |
| app-ahead | up-to-date | ok | ↑1 ↓0 | already up to date |
| app-behind | would-sync | ok | ↑0 ↓1 | — |
| app-dirty | skipped | skipped | ↑0 ↓0 | working tree is dirty (0 staged, 1 modified, 1 untracked) |
| app-nested/deep | up-to-date | ok | ↑0 ↓0 | already up to date |
```

## 它不会做什么

- **不 force push、不 `reset --hard`、不自行重写历史。** 同步先 fetch，默认用 `--ff-only` 整合；只有你明确指定 `mode: 'rebase'` 或 `'merge'` 才会用对应方式。`push` 就是普通 `git push`。
- **没有提交信息就不提交。** `messages` 必填，每个值都必须是非空字符串；匹配不到任何仓库 label 的 key 会报错，而不是被静默忽略。
- **不同步脏仓库。** 有已暂存、已修改、未跟踪或冲突文件的仓库会被跳过并给出原因 —— 十个仓库同时解错冲突，比留下一个给你手工处理更糟。跳过是「已报告的决策」，不计入失败。
- **不碰 bare 仓库。** 发现逻辑只认 `.git` 目录或 worktree 的 `.git` 文件；磁盘上的 bare 远端会被忽略，`node_modules`、`dist`、`build`、`target`、`.venv` 和点目录都会被跳过。submodule 自带 `.git` 文件，因此会作为独立仓库出现。
- **不做部分暂存。** `git_workspace_commit` 对每个被提交的仓库执行 `git add --all`。
- **不处理凭据。** 用你 `git` 里已有的认证配置；`GIT_TERMINAL_PROMPT` 被关闭，缺凭据会快速失败而不是挂住。

### 安全边界

`root` 来自模型生成的参数，而所有操作都在该目录里执行 `git`。因此它被限制在调用会话的工作区内：超出工作区的 `root` 会在任何 `git` 进程启动前被拒绝。确实需要扫描更宽的范围时，在插件配置里设 `allowOutsideRoot: true`。

只读工具（`status`、`changes`）从不写盘。`sync`、`commit`、`push` 都支持 `dryRun`；其中 sync 的预览仍会 fetch，因为看不见上游提交的预览会给出错误结论 —— 但它绝不整合、不 reset、不写工作区。

## 实现方式

```
lib/index.js    cordis 插件：导出 name / inject / apply，注册五个工具
lib/git.mjs     git 原语：发现、状态、同步、变更、提交、推送
lib/format.mjs  每批结果的 markdown 渲染
```

发现逻辑从根目录按 `maxDepth` 深度优先遍历，带 `.git` 的目录即一个项目，并继续向其内部遍历（覆盖 worktree 与嵌套项目）；200 个仓库的硬上限防止错误的根目录变成无边界扫描。状态解析自 `git status --porcelain=v2 --branch`，ahead/behind 取仓库自身对 upstream 的认知。

每个单仓库操作都以结果对象 resolve、从不 reject：插件报告部分失败，而不是丢掉整批结果。

## 开发

```bash
node --test                                # 22 个用例，在临时目录里跑真实 git 仓库
node scripts/smoke.mjs                     # 打印状态表、sync dry run 与变更摘要

# 可选：用真实工具注册表（而非测试桩）验证 schema 能编译通过
npm i --no-save @deepseek-ai/dsh-tools && node scripts/validate-schema.mjs
```

没有安装步骤：运行时零依赖。`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis` 是由宿主提供的 peer 依赖，插件测试通过 loader hook 打桩前者。

## 兼容性

| | |
| --- | --- |
| dsh | `>= 0.2.1-rc.3` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| 平台 | Windows、macOS、Linux（能跑 `git` 即可） |
| 宿主形态 | 仅 host 侧的工具插件 —— 没有浏览器半边，无 `dsh.client` 条目 |

## 许可证

[MIT](./LICENSE)
