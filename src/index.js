#!/usr/bin/env node

/**
 * JMeter MCP Server
 * 
 * An MCP (Model Context Protocol) server that provides JMeter-style API testing
 * capabilities for Claude Code. Supports HTTP requests, load testing, assertions,
 * and report generation — all without requiring Java or JMeter installation.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// HTTP Request Engine
// ============================================================

/**
 * Perform a single HTTP request
 */
async function httpRequest({ url, method = "GET", headers = {}, body, params, timeout = 30000, followRedirects = true, maxRedirects = 5 }) {
  const startTime = Date.now();

  // Build URL with query params
  let fullUrl = url;
  if (params && Object.keys(params).length > 0) {
    const urlObj = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      urlObj.searchParams.append(k, String(v));
    }
    fullUrl = urlObj.toString();
  }

  // Build fetch options
  const fetchOpts = {
    method: method.toUpperCase(),
    headers,
    redirect: followRedirects ? "follow" : "manual",
    signal: AbortSignal.timeout(timeout),
  };

  // Add body for non-GET/HEAD requests
  if (body && !["GET", "HEAD"].includes(method.toUpperCase())) {
    if (typeof body === "object") {
      fetchOpts.body = JSON.stringify(body);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        fetchOpts.headers["Content-Type"] = "application/json";
      }
    } else {
      fetchOpts.body = String(body);
    }
  }

  let response;
  let redirectCount = 0;
  let redirectHistory = [];

  try {
    response = await fetch(fullUrl, fetchOpts);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    return {
      success: false,
      error: err.message,
      elapsed,
      url: fullUrl,
      method: method.toUpperCase(),
    };
  }

  const elapsed = Date.now() - startTime;
  const status = response.status;
  const statusText = response.statusText;
  const responseHeaders = {};
  response.headers.forEach((v, k) => { responseHeaders[k] = v; });

  // Read response body
  let responseBody;
  const contentType = response.headers.get("content-type") || "";
  try {
    if (contentType.includes("json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }
  } catch {
    responseBody = "";
  }

  // Truncate large responses
  const MAX_BODY_SIZE = 50000;
  let bodyTruncated = false;
  let bodyStr = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody, null, 2);
  if (bodyStr.length > MAX_BODY_SIZE) {
    bodyStr = bodyStr.substring(0, MAX_BODY_SIZE) + "\n... [truncated]";
    bodyTruncated = true;
  }

  return {
    success: status >= 200 && status < 300,
    statusCode: status,
    statusText,
    elapsed,
    url: fullUrl,
    method: method.toUpperCase(),
    responseHeaders,
    body: bodyStr,
    bodyTruncated,
    bodySize: typeof responseBody === "string" ? responseBody.length : JSON.stringify(responseBody).length,
    contentType,
  };
}

// ============================================================
// Load Test Engine
// ============================================================

/**
 * Run a load test with concurrent requests
 */
async function loadTest({ url, method = "GET", headers = {}, body, params, concurrency = 1, iterations = 1, rampUp = 0, timeout = 30000 }) {
  const results = [];
  const totalRequests = iterations;
  let completed = 0;
  let errors = 0;

  console.error(`[jmeter-mcp] Load test: ${totalRequests} requests, ${concurrency} concurrent, rampUp=${rampUp}ms`);

  async function runSingleRequest(index) {
    // Ramp-up delay
    if (rampUp > 0 && concurrency > 1) {
      const delay = (rampUp / concurrency) * (index % concurrency);
      await new Promise(r => setTimeout(r, delay));
    }

    const result = await httpRequest({ url, method, headers, body, params, timeout });
    completed++;

    if (!result.success) errors++;

    results.push({
      requestIndex: index,
      statusCode: result.statusCode,
      elapsed: result.elapsed,
      success: result.success,
      error: result.error || null,
    });

    return result;
  }

  const startTime = Date.now();

  // Run requests with concurrency control
  const promises = [];
  for (let i = 0; i < totalRequests; i++) {
    promises.push(runSingleRequest(i));
  }

  // Control concurrency
  const executing = new Set();
  for (const p of promises) {
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing).then(() => executing.delete(p));
    }
  }
  await Promise.all(executing);

  const totalTime = Date.now() - startTime;

  // Calculate statistics
  const elapsedTimes = results.map(r => r.elapsed).sort((a, b) => a - b);
  const successCount = results.filter(r => r.success).length;
  const errorCount = results.filter(r => !r.success).length;

  const avg = elapsedTimes.reduce((s, t) => s + t, 0) / elapsedTimes.length;
  const min = elapsedTimes[0];
  const max = elapsedTimes[elapsedTimes.length - 1];
  const p50 = elapsedTimes[Math.floor(elapsedTimes.length * 0.5)];
  const p90 = elapsedTimes[Math.floor(elapsedTimes.length * 0.9)];
  const p95 = elapsedTimes[Math.floor(elapsedTimes.length * 0.95)];
  const p99 = elapsedTimes[Math.floor(elapsedTimes.length * 0.99)];
  const throughput = (totalRequests / (totalTime / 1000)).toFixed(2);

  return {
    summary: {
      totalRequests,
      successCount,
      errorCount,
      errorRate: ((errorCount / totalRequests) * 100).toFixed(2) + "%",
      totalTime,
      throughput: parseFloat(throughput),
    },
    latency: {
      min,
      max,
      avg: Math.round(avg),
      p50,
      p90,
      p95,
      p99,
    },
    statusCodes: results.reduce((acc, r) => {
      const code = r.statusCode || "error";
      acc[code] = (acc[code] || 0) + 1;
      return acc;
    }, {}),
    details: totalRequests <= 20 ? results : results.slice(0, 10).concat([{ note: `... ${totalRequests - 10} more results omitted` }]),
  };
}

// ============================================================
// Assertion Engine
// ============================================================

/**
 * Run assertions against an HTTP response
 */
function runAssertions(response, assertions = []) {
  const results = [];

  for (const assertion of assertions) {
    const { type, target, operator, expected, name } = assertion;
    let passed = false;
    let actual = null;
    let message = "";

    try {
      switch (type) {
        case "status":
        case "statusCode": {
          actual = response.statusCode;
          passed = compareValues(actual, operator, Number(expected));
          message = `Status code ${actual} ${operator} ${expected}`;
          break;
        }
        case "body":
        case "responseBody": {
          actual = response.body;
          if (target) {
            // JSON path extraction (simple dot notation)
            actual = extractJsonPath(response.body, target);
          }
          passed = compareValues(actual, operator, expected);
          message = `Body${target ? `.${target}` : ""}: ${truncate(String(actual), 100)} ${operator} ${expected}`;
          break;
        }
        case "header":
        case "responseHeader": {
          actual = response.responseHeaders[target?.toLowerCase()] || null;
          passed = compareValues(actual, operator, expected);
          message = `Header "${target}": ${actual} ${operator} ${expected}`;
          break;
        }
        case "elapsed":
        case "responseTime": {
          actual = response.elapsed;
          passed = compareValues(actual, operator, Number(expected));
          message = `Response time ${actual}ms ${operator} ${expected}ms`;
          break;
        }
        case "json": {
          // Parse body as JSON and check path
          let parsed = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
          if (target) {
            actual = extractJsonPath(parsed, target);
          } else {
            actual = parsed;
          }
          passed = compareValues(actual, operator, expected);
          message = `JSON${target ? `.${target}` : ""}: ${truncate(String(actual), 100)} ${operator} ${expected}`;
          break;
        }
        default:
          message = `Unknown assertion type: ${type}`;
      }
    } catch (err) {
      passed = false;
      message = `Assertion error: ${err.message}`;
    }

    results.push({ name: name || type, passed, actual: truncate(String(actual || ""), 200), expected: String(expected), message });
  }

  return results;
}

/**
 * Simple JSON path extraction (dot notation + array index)
 */
function extractJsonPath(obj, path) {
  if (!obj || !path) return obj;
  
  // If obj is a string, try to parse it
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return undefined; }
  }

  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    // Handle array index: items[0] or items[0].name
    const match = part.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      current = current[match[1]]?.[parseInt(match[2])];
    } else {
      current = current[part];
    }
  }
  return current;
}

/**
 * Compare values with various operators
 */
function compareValues(actual, operator, expected) {
  switch (operator) {
    case "eq":
    case "==":
    case "equals":
      return String(actual) === String(expected);
    case "neq":
    case "!=":
      return String(actual) !== String(expected);
    case "gt":
    case ">":
      return Number(actual) > Number(expected);
    case "gte":
    case ">=":
      return Number(actual) >= Number(expected);
    case "lt":
    case "<":
      return Number(actual) < Number(expected);
    case "lte":
    case "<=":
      return Number(actual) <= Number(expected);
    case "contains":
      return String(actual).includes(String(expected));
    case "notContains":
      return !String(actual).includes(String(expected));
    case "matches": {
      const re = new RegExp(String(expected));
      return re.test(String(actual));
    }
    case "exists":
      return actual !== undefined && actual !== null;
    case "notExists":
      return actual === undefined || actual === null;
    default:
      return false;
  }
}

function truncate(str, maxLen) {
  if (!str) return str;
  return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}

// ============================================================
// Test Plan Runner
// ============================================================

/**
 * Run a sequence of HTTP requests (test plan)
 */
async function runTestPlan({ steps, stopOnError = false }) {
  const results = [];
  let context = { variables: {} };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepName = step.name || `Step ${i + 1}`;

    console.error(`[jmeter-mcp] Running step: ${stepName}`);

    // Resolve variables in URL, body, headers
    const resolvedUrl = resolveVars(step.url, context.variables);
    const resolvedBody = step.body
      ? (typeof step.body === "string" ? resolveVars(step.body, context.variables) : step.body)
      : undefined;
    const resolvedHeaders = {};
    if (step.headers) {
      for (const [k, v] of Object.entries(step.headers)) {
        resolvedHeaders[k] = resolveVars(String(v), context.variables);
      }
    }

    // Execute request
    const response = await httpRequest({
      url: resolvedUrl,
      method: step.method || "GET",
      headers: resolvedHeaders,
      body: resolvedBody,
      params: step.params,
      timeout: step.timeout,
    });

    // Extract variables
    let assertionResults = [];
    if (step.assertions && step.assertions.length > 0) {
      assertionResults = runAssertions(response, step.assertions);
    }

    // Variable extraction
    if (step.extract) {
      for (const [varName, extraction] of Object.entries(step.extract)) {
        const { type, path, regex } = extraction;
        let value;
        if (type === "json" && path) {
          value = extractJsonPath(response.body, path);
        } else if (type === "header" && path) {
          value = response.responseHeaders[path.toLowerCase()];
        } else if (type === "regex" && regex) {
          const match = String(response.body).match(new RegExp(regex));
          value = match ? (match[1] || match[0]) : null;
        } else if (type === "body") {
          value = response.body;
        }
        if (value !== undefined && value !== null) {
          context.variables[varName] = value;
        }
      }
    }

    const stepResult = {
      name: stepName,
      index: i,
      request: {
        url: resolvedUrl,
        method: (step.method || "GET").toUpperCase(),
      },
      response: {
        statusCode: response.statusCode,
        elapsed: response.elapsed,
        success: response.success,
        bodySize: response.bodySize,
      },
      assertions: assertionResults,
      extractedVars: step.extract ? Object.fromEntries(
        Object.entries(step.extract).map(([k]) => [k, context.variables[k]])
      ) : undefined,
    };

    results.push(stepResult);

    // Check if should stop on error
    if (stopOnError && !response.success) {
      results.push({ stopped: true, reason: `Step "${stepName}" failed with status ${response.statusCode}` });
      break;
    }

    if (stopOnError && assertionResults.some(a => !a.passed)) {
      results.push({ stopped: true, reason: `Step "${stepName}" assertion failed` });
      break;
    }

    // Delay between steps
    if (step.delay) {
      await new Promise(r => setTimeout(r, step.delay));
    }
  }

  const totalElapsed = results.reduce((s, r) => s + (r.response?.elapsed || 0), 0);
  const allAssertions = results.flatMap(r => r.assertions || []);
  const passedSteps = results.filter(r => r.response?.success).length;
  const failedSteps = results.filter(r => r.response && !r.response.success).length;

  return {
    summary: {
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      totalElapsed,
      assertionsTotal: allAssertions.length,
      assertionsPassed: allAssertions.filter(a => a.passed).length,
      assertionsFailed: allAssertions.filter(a => !a.passed).length,
    },
    variables: context.variables,
    steps: results,
  };
}

function resolveVars(str, vars) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\$\{(\w+)\}/g, (match, name) => {
    return vars[name] !== undefined ? String(vars[name]) : match;
  });
}

// ============================================================
// MCP Server Definition
// ============================================================

const server = new Server(
  {
    name: "jmeter-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "http_request",
      description: "Send an HTTP request (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS). Returns status code, headers, body, and timing. Use for API testing and exploration.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to request" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], default: "GET", description: "HTTP method" },
          headers: { type: "object", description: "Request headers as key-value pairs", additionalProperties: { type: "string" } },
          body: { description: "Request body (string or object)" },
          params: { type: "object", description: "Query parameters as key-value pairs", additionalProperties: { type: "string" } },
          timeout: { type: "number", default: 30000, description: "Request timeout in milliseconds" },
        },
        required: ["url"],
      },
    },
    {
      name: "load_test",
      description: "Run a load test against a URL. Sends multiple requests with configurable concurrency, iterations, and ramp-up. Returns latency statistics (avg, p50, p90, p95, p99), throughput, and error rates — like a simplified JMeter test.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to test" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], default: "GET" },
          headers: { type: "object", description: "Request headers", additionalProperties: { type: "string" } },
          body: { description: "Request body" },
          params: { type: "object", description: "Query parameters", additionalProperties: { type: "string" } },
          concurrency: { type: "number", default: 1, description: "Number of concurrent users/connections" },
          iterations: { type: "number", default: 10, description: "Total number of requests to send" },
          rampUp: { type: "number", default: 0, description: "Ramp-up time in milliseconds to reach full concurrency" },
          timeout: { type: "number", default: 30000, description: "Per-request timeout in milliseconds" },
        },
        required: ["url"],
      },
    },
    {
      name: "assert_response",
      description: "Run assertions against a previous HTTP response. Supports assertions on: status code, response body (text/JSON path), response headers, and response time. Returns pass/fail for each assertion with actual values.",
      inputSchema: {
        type: "object",
        properties: {
          response: { type: "object", description: "The response object from http_request to assert against" },
          assertions: {
            type: "array",
            description: "List of assertions to run",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Assertion name/description" },
                type: { type: "string", enum: ["statusCode", "body", "responseBody", "header", "responseHeader", "elapsed", "responseTime", "json"], description: "What to assert on" },
                target: { type: "string", description: "Target path (JSON path for body/json, header name for header)" },
                operator: { type: "string", enum: ["eq", "==", "equals", "neq", "!=", "gt", ">", "gte", ">=", "lt", "<", "lte", "<=", "contains", "notContains", "matches", "exists", "notExists"], description: "Comparison operator" },
                expected: { description: "Expected value" },
              },
              required: ["type", "operator"],
            },
          },
        },
        required: ["response", "assertions"],
      },
    },
    {
      name: "run_test_plan",
      description: "Execute a multi-step API test plan (like a JMeter test plan). Each step is an HTTP request with optional assertions and variable extraction. Variables extracted in one step can be used in subsequent steps using ${varName} syntax. Supports stop-on-error and step delays.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered list of test steps",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Step name" },
                url: { type: "string", description: "Request URL (supports ${varName} substitution)" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], default: "GET" },
                headers: { type: "object", description: "Request headers", additionalProperties: { type: "string" } },
                body: { description: "Request body (supports ${varName} substitution)" },
                params: { type: "object", description: "Query parameters", additionalProperties: { type: "string" } },
                timeout: { type: "number", default: 30000 },
                delay: { type: "number", description: "Delay in ms before this step" },
                assertions: {
                  type: "array",
                  description: "Assertions for this step",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      type: { type: "string", enum: ["statusCode", "body", "json", "header", "elapsed"] },
                      target: { type: "string" },
                      operator: { type: "string", enum: ["eq", "==", "equals", "neq", "!=", "gt", ">", "gte", ">=", "lt", "<", "lte", "<=", "contains", "notContains", "matches", "exists", "notExists"] },
                      expected: {},
                    },
                    required: ["type", "operator"],
                  },
                },
                extract: {
                  type: "object",
                  description: "Variables to extract from response. Key = variable name, value = { type: 'json'|'header'|'regex'|'body', path?: string, regex?: string }",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["json", "header", "regex", "body"] },
                      path: { type: "string" },
                      regex: { type: "string" },
                    },
                  },
                },
              },
              required: ["url"],
            },
          },
          stopOnError: { type: "boolean", default: false, description: "Stop the plan if any step fails" },
        },
        required: ["steps"],
      },
    },
    {
      name: "generate_report",
      description: "Generate a summary report from test results (from load_test or run_test_plan). Formats results as a human-readable Markdown report.",
      inputSchema: {
        type: "object",
        properties: {
          results: { type: "object", description: "The results object from load_test or run_test_plan" },
          title: { type: "string", default: "API Test Report", description: "Report title" },
          format: { type: "string", enum: ["markdown", "json"], default: "markdown", description: "Output format" },
        },
        required: ["results"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "http_request": {
        const result = await httpRequest(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "load_test": {
        const result = await loadTest(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "assert_response": {
        const results = runAssertions(args.response, args.assertions);
        const allPassed = results.every(r => r.passed);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              allPassed,
              passedCount: results.filter(r => r.passed).length,
              failedCount: results.filter(r => !r.passed).length,
              results,
            }, null, 2),
          }],
        };
      }

      case "run_test_plan": {
        const result = await runTestPlan(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "generate_report": {
        const { results, title = "API Test Report", format = "markdown" } = args;

        if (format === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          };
        }

        // Generate Markdown report
        let md = `# ${title}\n\n`;
        md += `**Generated:** ${new Date().toISOString()}\n\n`;

        // Check if it's a load test result or test plan result
        if (results.summary && results.latency) {
          // Load test report
          md += `## Load Test Summary\n\n`;
          md += `| Metric | Value |\n|--------|-------|\n`;
          md += `| Total Requests | ${results.summary.totalRequests} |\n`;
          md += `| Success | ${results.summary.successCount} |\n`;
          md += `| Errors | ${results.summary.errorCount} |\n`;
          md += `| Error Rate | ${results.summary.errorRate} |\n`;
          md += `| Total Time | ${results.summary.totalTime}ms |\n`;
          md += `| Throughput | ${results.summary.throughput} req/s |\n\n`;

          md += `## Latency Statistics\n\n`;
          md += `| Percentile | Latency |\n|------------|--------|\n`;
          md += `| Min | ${results.latency.min}ms |\n`;
          md += `| Avg | ${results.latency.avg}ms |\n`;
          md += `| P50 | ${results.latency.p50}ms |\n`;
          md += `| P90 | ${results.latency.p90}ms |\n`;
          md += `| P95 | ${results.latency.p95}ms |\n`;
          md += `| P99 | ${results.latency.p99}ms |\n`;
          md += `| Max | ${results.latency.max}ms |\n\n`;

          if (results.statusCodes) {
            md += `## Status Code Distribution\n\n`;
            md += `| Status Code | Count |\n|-------------|-------|\n`;
            for (const [code, count] of Object.entries(results.statusCodes)) {
              md += `| ${code} | ${count} |\n`;
            }
          }
        } else if (results.summary && results.steps) {
          // Test plan report
          md += `## Test Plan Summary\n\n`;
          md += `| Metric | Value |\n|--------|-------|\n`;
          md += `| Total Steps | ${results.summary.totalSteps} |\n`;
          md += `| Passed | ${results.summary.passedSteps} |\n`;
          md += `| Failed | ${results.summary.failedSteps} |\n`;
          md += `| Total Time | ${results.summary.totalElapsed}ms |\n`;
          md += `| Assertions | ${results.summary.assertionsTotal} total, ${results.summary.assertionsPassed} passed, ${results.summary.assertionsFailed} failed |\n\n`;

          md += `## Step Details\n\n`;
          for (const step of results.steps) {
            if (step.stopped) {
              md += `### ⚠️ STOPPED: ${step.reason}\n\n`;
              continue;
            }
            const icon = step.response?.success ? "✅" : "❌";
            md += `### ${icon} ${step.name}\n\n`;
            md += `- **${step.request.method}** ${step.request.url}\n`;
            md += `- Status: ${step.response?.statusCode} | Time: ${step.response?.elapsed}ms\n`;
            if (step.assertions?.length > 0) {
              md += `- Assertions: ${step.assertions.filter(a => a.passed).length}/${step.assertions.length} passed\n`;
              for (const a of step.assertions) {
                md += `  - ${a.passed ? "✅" : "❌"} ${a.message}\n`;
              }
            }
            if (step.extractedVars) {
              md += `- Extracted: ${JSON.stringify(step.extractedVars)}\n`;
            }
            md += `\n`;
          }
        }

        return {
          content: [{ type: "text", text: md }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}\n${err.stack}` }],
      isError: true,
    };
  }
});

// ============================================================
// Start Server
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[jmeter-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[jmeter-mcp] Fatal error:", err);
  process.exit(1);
});
