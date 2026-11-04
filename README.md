# 面试专家 · 备战工作台

个人面试备战工作台。**一个链接就够用**：所有工具都在这个纯静态站里跑，不用开后端。

## 主地址

https://linziyang777.github.io/interview-expert/

| 工具 | 地址 | 说明 |
|---|---|---|
| 定制生成（改简历就变稿） | `docs/custom.html` | 填公司/岗位/JD/简历 → 算缺口 → 勾题出稿 |
| AI 模拟考场 | `docs/room/index.html` | 群面 + 单面，AI 面试官对练、抢话、多维复盘 |
| 贴题出框架 | `docs/frame.html` | 贴题 → 出结构树 → 导出 .xmind |
| 稿子 / PDF / 倒计时 | `docs/*.html` | 拼多多二面五章稿、备战总册、作战稿、解题卡等 |

## 模拟考场怎么用

1. 打开 `docs/room/index.html`，会弹一个「解锁」框。
2. **点「先用本地的」** → 直接进考场，走固定剧本，流程完整（选题、抢话、推进、复盘雷达图都能出）。
3. 想和真 AI 对话 → 在「解锁」框输入口令。口令对了，浏览器直连模型，请求不经过任何服务器。

静态版的 9 个后端接口（`/api/meta`、`/api/session`、`/api/chat`、`/api/finish`、
`/api/group/start|speak|auto|next|review`）由 `docs/room/room_local.js` 在浏览器里实现：
它把 `window.fetch` 换掉，同目录下的 `meta.json` / `prompts.json` 提供题池、人设、清单、提示词。

## 目录结构

```
index.html              工作台首页（所有入口）
docs/                   全部页面 + PDF
  custom.html           定制生成
  frame.html            贴题出框架
  room/                 AI 模拟考场（静态版）
    index.html          考场主页面
    room_local.js       浏览器内接口实现
    meta.json           题池 / 人设 / 维度 / 清单 / 面试官
    prompts.json        提示词与本地剧本台词
  config.enc.js         模型 Key 密文（口令解锁，PBKDF2 + Fernet）
  tailor_static.js      定制生成的静态版逻辑
push.py                 推送脚本（GitHub Contents API）
```

## 说明

- 本站纯静态，数据（简历、JD、答题记录）只存浏览器本机，不上传。
- 模型调用直接从浏览器发出；不解锁口令时全部走本地剧本，不产生任何 API 费用。
- 材料均为个人备战整理，非官方口径。

## 备用：自建服务器版

功能相同的动态版：https://a1bb3b6066bf43ba2.app.workbuddy.host/portal
（部署到自己的云服务器见 `面试专家-部署包.tar.gz` 内的 `deploy/README.md`）
