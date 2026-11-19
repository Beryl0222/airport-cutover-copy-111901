# 机场切换时的旅客通知编写与更正

notices 是非结构化运行说明，bookings 的 date 是订座服务日，scheduled 和 actual 是带时区的计划与实际时间。channels 给出本地模拟网关的字符预算。receipts 区分实际送达与入账时间，M1 是导入前已派发短信的编号。issuedAt 为说明发出时间。sent 是旧系统实际发出的通知副本，link 为模拟行程入口，送达事实由 receipts 另行记录。

资料保存在 `data/inputs.json`，采用 UTF-8 JSON。记录、人员、地点和业务编号均为合成内容。

运行环境为 Node.js 22.23.4，资料工具和测试使用 Node.js 标准库。

```sh
npm run inspect:data
npm test
```

`inspect:data` 读取资料并列出记录数。测试核对该批资料的字段和引用完整性。
