# 面试专家

## 主地址（打开就直接进动态版）

https://linziyang777.github.io/interview-expert/

`index.html` 是个中转页，打开就 `location.replace` 到动态版总台：

- 总台：https://a1bb3b6066bf43ba2.app.workbuddy.host/portal
- 模拟考场：https://a1bb3b6066bf43ba2.app.workbuddy.host/room/?go=group
- 贴题出框架：https://a1bb3b6066bf43ba2.app.workbuddy.host/

## 备份

- `archive.html` —— 静态备份页（稿子 / PDF / 倒计时 / 纯前端生成）
- 静态考场：`docs/room/index.html`

## 口令模式（重要）

动静两版的模型调用都不再让人输口令，**打开就用内置口令直连**，所以一进去就会消耗 API 额度。

想改回手动输口令：把对应文件里的 `PASS_MODE` 从 `'auto'` 改成 `'ask'`，重新上传。

| 文件 | 管哪一页 |
|---|---|
| `docs/tailor_static.js` | 定制生成（custom.html） |
| `docs/room/room_local.js` | 静态考场 |

```js
var PASS_MODE = 'auto';          // 'auto' 自动直连 / 'ask' 每次输口令
var DEFAULT_PASS = 'ziyang-1029';
```

改完先过一遍语法检查再上传：

```bash
node --check docs/tailor_static.js
node --check docs/room/room_local.js
python3 push.py docs/tailor_static.js docs/room/room_local.js
```

## 目录

```
index.html              中转页（→ 动态版）
archive.html            静态备份页
docs/
  custom.html           定制生成
  room/                 静态考场（备用）
  config.enc.js         模型 Key 密文（PBKDF2 200k + Fernet）
  tailor_static.js      定制生成的静态逻辑
push.py                 GitHub Contents API 推送脚本
```

## 说明

- 静态站的简历 / JD / 答题记录只存浏览器本机。
- 动态版数据在服务端，功能与静态站一致。
- 材料均为个人备战整理，非官方口径。
