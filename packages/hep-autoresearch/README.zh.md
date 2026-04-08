# HEP Autoresearch（中文说明）

这是 Autoresearch Lab monorepo 中偏 HEP 的 provider 包，以及仍在收缩中的 legacy 过渡实现面。

它已经不是 generic 产品前门。当前公开用户应使用：

- generic lifecycle 与 bounded computation：`autoresearch`
- 高层 literature planning：`autoresearch workflow-plan`
- 当前成熟的 HEP MCP 面：`@autoresearch/hep-mcp`

这个目录仍保留在公开 monorepo 中，是因为里面还有实现代码、测试和 package 元数据；但 maintainer-only 的 legacy 文档、workflow 说明和 examples 现在只保留在本地，不再作为 GitHub 公开内容发布。

当前面向用户的说明请从这里开始：

- [根 README](../../README.md)
- [Quickstart](../../docs/QUICKSTART.md)
- [测试指南](../../docs/TESTING_GUIDE.md)

如果你只是作为使用者阅读这个包，记住三点即可：

- 前门是 `autoresearch`
- 不要把 `hep-autoresearch` / `hepar` 当成产品主身份
- 不要期待安装态 `hepar` / `hep-autoresearch` public shell 继续存在
- 剩余 legacy Python 内部实现只会继续收缩，不会重新扩张
