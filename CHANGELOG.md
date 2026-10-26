# Changelog

## 2.1

- Fixed Flux dispatcher detection by requiring `_actionHandlers`.
- Ignored `DeepSeek Harness` as a real game so it no longer suppresses the fake presence.
- Applied the ignored-game filter to `getRunningGames`, `getVisibleGame`, and `getVisibleRunningGames`.
- Added `pauseSwitching()` and `resumeSwitching()`.
- Added `setIntervalMinutes(min, max)`.
- Added `ignoreRealGame(pattern)`.
- Added `version` and `switching` properties.
