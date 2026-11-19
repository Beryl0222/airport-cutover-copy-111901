# 机场更换候机动线时的多语种旅客指引

signs 给出标牌编号、楼层和现场展示文字。corridors 是允许通行的有向边，stepFree 表示全段无阶差。closures 中 notice 是运营员提交的状态说明，corridor 是其附带的关联编号。sessions 保存问路原句话和最后确认为亲眼看到的标牌。channels 的长度以 Unicode 码点计算。

资料保存在 `data/inputs.json`，采用 UTF-8 JSON。记录、人员、地点和业务编号均为合成内容。

运行环境为 Node.js 22.23.4，资料工具和测试使用 Node.js 标准库。

```sh
npm run inspect:data
npm test
```

`inspect:data` 读取资料并列出记录数。测试核对该批资料的字段和引用完整性。
