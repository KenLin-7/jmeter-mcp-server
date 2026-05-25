# JMeter MCP Server

一个轻量级的 API 测试 MCP Server，提供 JMeter 风格的接口测试能力，无需安装 Java 或 JMeter。

## 功能

### 5 个核心工具

| 工具 | 说明 |
|------|------|
| `http_request` | 发送单个 HTTP 请求（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS） |
| `load_test` | 负载测试：并发请求、延迟统计（P50/P90/P95/P99）、吞吐量、错误率 |
| `assert_response` | 对响应做断言：状态码、响应体、JSON 路径、Header、响应时间 |
| `run_test_plan` | 多步骤测试计划：支持变量提取 `${varName}`、断言、停止条件 |
| `generate_report` | 生成 Markdown 格式的测试报告 |

### 特性

- ✅ 纯 Node.js 实现，无需 Java/JMeter
- ✅ MCP stdio 协议，直接集成 Claude Code
- ✅ 支持 JSON/文本/表单请求体
- ✅ 支持 JSON Path 提取变量
- ✅ 支持正则表达式提取
- ✅ 断言：状态码、响应体、Header、响应时间、JSON 值
- ✅ 负载测试：并发控制、ramp-up、延迟统计
- ✅ 测试计划：多步骤串联、变量传递、stop-on-error
- ✅ Markdown 报告生成

## 安装

```bash
cd /root/jmeter-mcp-server
npm install
```

## 配置到 Claude Code

```bash
claude mcp add jmeter -- node /root/jmeter-mcp-server/src/index.js
```

## 使用示例

### 1. 简单 GET 请求
```
用 http_request 测试 https://httpbin.org/get
```

### 2. POST 请求
```
用 http_request POST https://httpbin.org/post，body 为 {"name": "test", "value": 123}
```

### 3. 负载测试
```
用 load_test 对 https://httpbin.org/get 发送 50 个请求，并发 10
```

### 4. 多步骤测试计划
```
用 run_test_plan 执行以下测试：
1. POST https://httpbin.org/post body={"user":"admin","pass":"123456"}，提取 response JSON 的 json.user 到变量 username
2. GET https://httpbin.org/get?user=${username}，断言状态码 == 200
```

### 5. 生成报告
```
用 generate_report 生成刚才测试的报告
```

## 断言操作符

| 操作符 | 说明 |
|--------|------|
| eq, ==, equals | 等于 |
| neq, != | 不等于 |
| gt, > | 大于 |
| gte, >= | 大于等于 |
| lt, < | 小于 |
| lte, <= | 小于等于 |
| contains | 包含 |
| notContains | 不包含 |
| matches | 正则匹配 |
| exists | 存在 |
| notExists | 不存在 |

## 断言类型

| 类型 | 说明 | target |
|------|------|--------|
| statusCode | HTTP 状态码 | - |
| body / responseBody | 响应体文本 | 可选 JSON path |
| json | JSON 响应 | JSON path |
| header / responseHeader | 响应头 | Header 名称 |
| elapsed / responseTime | 响应时间(ms) | - |

## 变量提取

在 test plan 的每个 step 中可以配置 `extract`：

```json
{
  "extract": {
    "token": { "type": "json", "path": "data.token" },
    "userId": { "type": "header", "path": "x-user-id" },
    "name": { "type": "regex", "regex": "\"name\":\"(\\w+)\"" }
  }
}
```

后续步骤中用 `${token}` 引用。
