# Kairo 開發入口

本專案使用私有 `taco3064/kairo` 的本機 Controller；公開 Actions 僅簽署事件通知，不執行私有 Core 或持有 Codex 登入。

## 建立工作

1. 由 Repository Owner 建立 Issue，寫明問題、預期結果、不做的範圍及完成條件，再加上 `scope`。
2. 用 GitHub 原生 `Blocked by` 設定實際依賴。各 repo 各自承擔實作與 PR。
3. 完成 Issue 規劃後，為新批次產生並核對授權摘要，簽署新的 Grant。新 Issue 不會自動取得舊批次授權。
4. 有效授權內的工作由 Kairo 執行 Shape、獨立驗證、Deliver、獨立 Accept、PR、GitHub 檢查、最終需求審查、合併及結案。`shaped` 和 `delivered` 由 Kairo 寫入。

## 此次重新接入

- 新安裝身分：`kairo-nibfin-restart-20261024`，使用獨立金鑰綁定與狀態目錄。
- 使用 Kairo 內建 `shape`、`deliver`、`accept` Skills。
- 事件包含 Issue 更新、指派變更及核准的 `Repository PR policy` 完成通知；原生依賴變更另經簽署 Webhook。
- 沒有排程或自動建立 Issue。Owner 可從 Actions 手動要求重新檢查。
- 重置前的 Grant、Scope、候選及交付紀錄保留為歷史，不授權新批次。
- 此次僅安裝入口與完成接入檢查；尚未簽署新產品開發 Grant，也未執行產品開發或 E2E。

執行時需保持指定筆電、WSL、Docker、私有 Runner 與事件通道在線。GitHub 的必要檢查與分支保護決定是否允許合併；未來新增 CI／部署流程時，須同步核對 Kairo 的完成通知清單與新授權中的責任。
