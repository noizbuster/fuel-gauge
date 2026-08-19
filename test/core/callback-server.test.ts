import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect as netConnect } from "node:net";
import { test } from "node:test";

import {
  CallbackError,
  type CallbackServer,
  createCallbackServerFactory,
} from "../../src/core/callback-server.js";

const STATE = "state-abc123";

const factory = createCallbackServerFactory();

interface ResponseCapture {
  status: number | undefined;
  body: string;
}

function getUrl(
  url: string,
  timeoutMs = 5_000,
): Promise<{ response: IncomingMessage; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    response: IncomingMessage;
    body: string;
  }>();
  const req = httpRequest(url, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    response.on("end", () => {
      resolve({ response, body });
    });
  });
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error("request timed out"));
  });
  req.on("error", reject);
  req.end();
  return promise;
}

async function withServer(
  kind: "codex" | "antigravity" | "kiro",
  run: (server: CallbackServer) => Promise<void>,
  options: { state?: string } = {},
): Promise<void> {
  const server = await factory.start({
    kind,
    expectedState: options.state ?? STATE,
    // Codex defaults to the fixed redirect port 1455, which the real
    // Codex CLI may hold on this machine — bind ephemeral so the suite
    // stays hermetic. Routing/state assertions are port-independent.
    port: kind === "codex" ? 0 : undefined,
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function _pendingForever(): Promise<never> {
  return new Promise<never>(() => {});
}

test("codex resolves only on the exact /auth/callback route", async () => {
  await withServer("codex", async (server) => {
    const wrongPath = await getUrl(
      `http://127.0.0.1:${server.port}/other?code=leak&state=${STATE}`,
    );
    assert.equal(wrongPath.response.statusCode, 200);
    assert.match(wrongPath.body, /still waiting/);

    const prefixed = await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback/evil?code=leak&state=${STATE}`,
    );
    assert.equal(prefixed.response.statusCode, 200);
    assert.match(prefixed.body, /still waiting/);
    await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?code=good-code&state=${STATE}`,
    );

    const success = await server.result;
    assert.equal(success.code, "good-code");
    assert.equal(success.state, STATE);
    assert.equal(success.path, "/auth/callback");
  });
});

test("codex rejects wrong state on the exact route with a typed error", async () => {
  await withServer("codex", async (server) => {
    const wrong = await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?code=x&state=evil`,
    );
    assert.equal(wrong.response.statusCode, 400);
    assert.match(wrong.body, /State mismatch/);

    await assert.rejects(
      server.result,
      (error: unknown) =>
        error instanceof CallbackError && error.code === "rejected",
    );
  });
});

test("codex rejects provider error callbacks", async () => {
  await withServer("codex", async (server) => {
    const failed = await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?error=access_denied&error_description=nope`,
    );
    assert.equal(failed.response.statusCode, 400);
    await assert.rejects(
      server.result,
      (error: unknown) =>
        error instanceof CallbackError &&
        error.code === "rejected" &&
        error.message.includes("access_denied"),
    );
  });
});

test("antigravity resolves only on the exact /oauth-callback route", async () => {
  await withServer("antigravity", async (server) => {
    for (const path of ["/oauth-callback-evil", "/oauth-callback/x", "/"]) {
      const wrong = await getUrl(
        `http://127.0.0.1:${server.port}${path}?code=leak&state=${STATE}`,
      );
      assert.equal(wrong.response.statusCode, 200);
      assert.match(wrong.body, /still waiting/);
    }

    await getUrl(
      `http://127.0.0.1:${server.port}/oauth-callback?code=ag-code&state=${STATE}`,
    );
    const success = await server.result;
    assert.equal(success.code, "ag-code");
    assert.equal(success.path, "/oauth-callback");
  });
});

test("antigravity rejects wrong state with a typed error", async () => {
  await withServer("antigravity", async (server) => {
    await getUrl(
      `http://127.0.0.1:${server.port}/oauth-callback?code=x&state=evil`,
    );
    await assert.rejects(
      server.result,
      (error: unknown) =>
        error instanceof CallbackError &&
        error.code === "rejected" &&
        error.message.includes("State mismatch"),
    );
  });
});

test("kiro keeps path-tolerant preflight and candidate-port semantics", async () => {
  const server = await factory.start({ kind: "kiro", expectedState: STATE });
  try {
    assert.ok(
      server.port === 3128 ||
        server.port === 4649 ||
        server.port === 6588 ||
        server.port === 8008 ||
        server.port === 9091 ||
        server.port >= 49153,
      `bound a Kiro candidate port, got ${server.port}`,
    );

    const preflight = await getUrl(
      `http://127.0.0.1:${server.port}/some/login/provider`,
    );
    assert.equal(preflight.response.statusCode, 200);
    assert.match(preflight.body, /Waiting for Kiro login/);

    const mismatch = await getUrl(
      `http://127.0.0.1:${server.port}/callback?code=x&state=evil`,
    );
    assert.equal(mismatch.response.statusCode, 400);
    await assert.rejects(
      server.result,
      (error: unknown) =>
        error instanceof CallbackError && error.code === "rejected",
    );
  } finally {
    await server.close();
  }
});

test("kiro resolves on an arbitrary provider path with the right state", async () => {
  await withServer("kiro", async (server) => {
    await getUrl(
      `http://127.0.0.1:${server.port}/idp/finish?code=kiro-code&state=${STATE}`,
    );
    const success = await server.result;
    assert.equal(success.code, "kiro-code");
    assert.equal(success.path, "/idp/finish");
  });
});

test("oversize declared body is refused and the wait continues", async () => {
  await withServer("antigravity", async (server) => {
    // GET on the exact route declaring a huge body: refused by the declared
    // length before any evaluation, and the flow keeps listening.
    const result = await new Promise<ResponseCapture>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: `/oauth-callback?code=late&state=${STATE}`,
          method: "GET",
          headers: { "content-length": String(20_000) },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({ status: response.statusCode, body });
          });
        },
      );
      req.on("error", (error) => {
        // A destroyed socket can surface as ECONNRESET after the 413 was
        // flushed; that still proves refusal, not acceptance.
        reject(error);
      });
      req.flushHeaders();
    }).catch((error: Error) => ({
      status: -1,
      body: `connection error: ${error.message}`,
    }));

    if (result.status !== undefined) {
      assert.equal(result.status, 413);
      assert.match(result.body, /body too large/i);
    }
    // The flow must still be listening afterwards.
    await getUrl(
      `http://127.0.0.1:${server.port}/oauth-callback?code=after&state=${STATE}`,
    );
    const success = await server.result;
    assert.equal(success.code, "after");
  });
});

test("a chunked oversize body gets 413 and never settles the flow", async () => {
  await withServer("codex", async (server) => {
    const received = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(server.port, "127.0.0.1");
      let text = "";
      socket.setTimeout(5_000, () => {
        socket.destroy(new Error("socket timed out"));
      });
      socket.on("connect", () => {
        socket.write(
          `GET /auth/callback?code=big&state=${STATE} HTTP/1.1\r\n` +
            "Host: localhost\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "Connection: close\r\n\r\n",
        );
        const chunk = "a".repeat(1_024);
        for (let i = 0; i < 12; i++) {
          socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        }
        socket.write("0\r\n\r\n");
      });
      socket.on("data", (data: Buffer) => {
        text += data.toString("utf8");
      });
      socket.on("error", reject);
      socket.on("close", () => {
        resolve(text);
      });
    });

    assert.match(received, /413/);
    assert.doesNotMatch(received, /200 OK/);

    // The oversized request must not have resolved the auth flow.
    let settled = false;
    server.result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false, "oversize body never settles the flow");

    // A subsequent well-formed callback still works.
    await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?code=clean&state=${STATE}`,
    );
    const success = await server.result;
    assert.equal(success.code, "clean");
  });
});

test("non-GET methods are refused without evaluating the callback", async () => {
  await withServer("codex", async (server) => {
    const posted = await new Promise<ResponseCapture>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: `/auth/callback?code=post&state=${STATE}`,
          method: "POST",
          headers: { "content-length": "0" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({ status: response.statusCode, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(posted.status, 405);

    let settled = false;
    server.result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false, "POST never settles the flow");

    await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?code=get&state=${STATE}`,
    );
    assert.equal((await server.result).code, "get");
  });
});

test("supplied state outranks attacker-chosen error text", async () => {
  await withServer("codex", async (server) => {
    await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?error=access_denied&state=evil`,
    );
    await assert.rejects(
      server.result,
      (error: unknown) =>
        error instanceof CallbackError &&
        error.code === "rejected" &&
        error.message.includes("State mismatch"),
    );
  });
});

test("error descriptions are bounded and redacted", async () => {
  await withServer("codex", async (server) => {
    const long = `${"x".repeat(400)} Bearer eyJhbGciOi.ATTACKER.TOKEN`;
    await getUrl(
      `http://127.0.0.1:${server.port}/auth/callback?error=access_denied&error_description=${encodeURIComponent(long)}`,
    );
    await assert.rejects(server.result, (error: unknown) => {
      assert.ok(error instanceof CallbackError);
      assert.equal(error.code, "rejected");
      assert.ok(!error.message.includes("eyJhbGciOi"), "token is redacted");
      assert.ok(!error.message.includes("ATTACKER"), "payload is redacted");
      assert.ok(error.message.length < 400, "message is bounded");
      return true;
    });
  });
});

test("abort during bind settles aborted and releases the port", async () => {
  const controller = new AbortController();
  const startPromise = factory.start({
    kind: "codex",
    expectedState: STATE,
    signal: controller.signal,
    port: 0,
  });
  // Abort after start() began but without awaiting the bind — this is the
  // window between the pre-bind aborted check and listener installation.
  controller.abort();

  await assert.rejects(
    startPromise,
    (error: unknown) =>
      error instanceof CallbackError && error.code === "aborted",
  );

  // The aborted listener released its port: a fresh start binds cleanly.
  const retry = await factory.start({
    kind: "codex",
    expectedState: STATE,
    port: 0,
  });
  await retry.close();
});

test("abort after start settles the result and releases the port", async () => {
  const controller = new AbortController();
  const server = await factory.start({
    kind: "antigravity",
    expectedState: STATE,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    server.result,
    (error: unknown) =>
      error instanceof CallbackError && error.code === "aborted",
  );
  await server.close();
});

test("close and cancel are idempotent and settle at most once", async () => {
  const server = await factory.start({
    kind: "antigravity",
    expectedState: STATE,
  });
  await server.close();
  await server.close();
  await server.cancel();
  await server.cancel();

  await assert.rejects(
    server.result,
    (error: unknown) =>
      error instanceof CallbackError && error.code === "cancelled",
  );

  // The ephemeral port is released: connections are refused.
  const refused = await new Promise<boolean>((resolve) => {
    const socket = netConnect(server.port, "127.0.0.1");
    socket.on("error", () => resolve(true));
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
  });
  assert.equal(refused, true, "port released after close");
});

test("post-resolution callback conflicts return the documented completion notice", async () => {
  await withServer("antigravity", async (server) => {
    await getUrl(
      `http://127.0.0.1:${server.port}/oauth-callback?code=first&state=${STATE}`,
    );
    const first = await server.result;
    assert.equal(first.code, "first");

    // The listener stays up briefly to answer the browser tab: a second
    // callback must get the harmless already-completed response and must
    // not change the resolved result.
    const second = await getUrl(
      `http://127.0.0.1:${server.port}/oauth-callback?code=second&state=${STATE}`,
    );
    assert.equal(second.response.statusCode, 200);
    assert.match(second.body, /already completed/i);
    assert.equal((await server.result).code, "first");
  });
});

test("all Kiro candidate ports busy yields the typed bind failure", async () => {
  const holders: Array<Promise<{ close(): Promise<void> }>> = [];
  try {
    const ports = [
      3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153,
    ];
    for (const port of ports) {
      holders.push(createServerProxy(port));
    }
    await Promise.all(holders);
    await assert.rejects(
      factory.start({ kind: "kiro", expectedState: STATE }),
      (error: unknown) =>
        error instanceof CallbackError &&
        error.code === "bind" &&
        /No available callback port/.test(error.message),
    );
  } finally {
    await Promise.all(
      holders.map((holder) => holder.then((handle) => handle.close())),
    );
  }
});

function createServerProxy(port: number): Promise<{
  close(): Promise<void>;
}> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("held");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}
