#!/bin/bash
# 把本目录推送为 GitHub 私有仓库（面试专家静态档案）
# 用法：
#   export GH_TOKEN=ghp_你的token     （github.com → Settings → Developer settings → Personal access tokens → 勾 repo 权限）
#   bash 推送到GitHub.sh
set -e
: "${GH_TOKEN:?请先 export GH_TOKEN=你的token（需要 repo 权限）}"
cd "$(dirname "$0")"

echo "$GH_TOKEN" | gh auth login --with-token >/dev/null 2>&1
OWNER=$(gh api user -q .login)
REPO=interview-expert

gh repo view "$OWNER/$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --private --disable-wiki

git init -q -b main 2>/dev/null || true
git add -A
git -c user.name="archive" -c user.email="archive@local" commit -qm "面试专家静态档案 $(date +%F)" 2>/dev/null || true
git branch -M main 2>/dev/null || true
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${OWNER}/${REPO}.git"
git push -q -u origin main --force

echo "完成 → https://github.com/${OWNER}/${REPO}  （私有，仅你自己可见）"
