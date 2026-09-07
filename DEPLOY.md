# Pet Memory 后端 v1.1 — 自动转码版
- 新增：上传 HEVC 视频时自动转码 H.264（浏览器可播放）
- 新增：依赖 @ffmpeg-installer/ffmpeg

## 重新部署（已有 GitHub 仓库 petmemory-server）
把本目录的 server.js、package.json、README.md 覆盖上传到 GitHub 仓库，Render 会自动检测到变更并重新部署（约 2-3 分钟，因为要 npm install 新依赖）。
