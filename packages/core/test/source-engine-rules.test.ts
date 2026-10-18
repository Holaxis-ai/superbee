/**
 * The robots.txt and address rules the source engine carries for every runner: the same vectors
 * hosted's page fetcher holds, so the hosted copy can be deleted for this one when it adopts core.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalRobotsPath,
  fetchIdentity,
  parseRobots,
  refusedAddress,
  robotsDecision,
  robotsRuleMatches,
} from "../src/source-engine/index.js";

test("a declared identity names a product, a version and an https contact; anything else is refused", () => {
  const identity = fetchIdentity("FairportBot/0.1 (+https://fairport.example.org/about; corrections@fairport.org)");
  assert.deepEqual(identity, { userAgent: "FairportBot/0.1 (+https://fairport.example.org/about; corrections@fairport.org)", productToken: "FairportBot" });
  for (const agent of ["FairportBot/0.1", "FairportBot/0.1 (+http://fairport.org)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "FairportBot (+https://fairport.org)"]) {
    assert.equal(fetchIdentity(agent), undefined, agent);
  }
});

test("robots.txt follows RFC 9309: own group over *, longest rule, Allow on a tie, wildcards and $", () => {
  const robots = ["User-agent: *", "Disallow: /", "", "User-agent: fairportbot", "Disallow: /private", "Allow: /private/press", "Disallow: /*.json$", "Allow: /tie", "Disallow: /tie"].join("\n");
  assert.equal(robotsDecision(robots, "/events", "FairportBot").allow, true);
  assert.deepEqual(robotsDecision(robots, "/private/x", "FairportBot"), { allow: false, rule: "Disallow: /private" });
  assert.equal(robotsDecision(robots, "/private/press/today", "FairportBot").allow, true);
  assert.equal(robotsDecision(robots, "/feed.json", "FairportBot").allow, false);
  assert.equal(robotsDecision(robots, "/feed.json?x=1", "FairportBot").allow, true);
  assert.equal(robotsDecision(robots, "/tie", "FairportBot").allow, true);
  assert.equal(robotsDecision(robots, "/events", "OtherBot").allow, false);
  assert.deepEqual(robotsDecision("", "/anything", "FairportBot"), { allow: true });
});

test("percent-encoding, product tokens and wildcards leave no way around a rule", () => {
  const robots = "User-agent: f\nAllow: /\n\nUser-agent: *\nDisallow: /private\nDisallow: /café\n";
  assert.equal(robotsDecision(robots, "/private", "FairportBot").allow, false);
  assert.equal(robotsDecision(robots, "/%70rivate", "FairportBot").allow, false);
  assert.equal(robotsDecision(robots, "/caf%C3%A9", "FairportBot").allow, false);
  assert.equal(robotsDecision(robots, "/%2Fprivate", "FairportBot").allow, true);
  assert.equal(robotsDecision("User-agent: FairportBot/0.1\nDisallow: /\n", "/x", "FairportBot").allow, false);
  assert.equal(canonicalRobotsPath("/%7euser/café?q=%2f"), "/~user/caf%C3%A9?q=%2F");
  assert.deepEqual(parseRobots("User-agent: A\nUser-agent: b-bot/2\nDisallow: /x # note\nAllow:\n"), [{ agents: ["a", "b-bot"], rules: [{ allow: false, path: "/x" }] }]);
  assert.equal(robotsDecision("User-agent: *\rDisallow: /private\r", "/private/x", "FairportBot").allow, false, "a bare CR ends a line");
  assert.equal(robotsDecision("User-agent: a\n\u212Aey: x\nUser-agent: b\nDisallow: /\n", "/x", "a").allow, false, "a key that only lowercases to ASCII is not a key");
  assert.equal(robotsRuleMatches("/a*b*c", "/aXbYcZ"), true, "two wildcards, an unanchored last part");
  assert.equal(robotsRuleMatches("/a*b*c", "/aXcYb"), false);
  assert.equal(robotsDecision("User-agent: *\nAllow: /p*q\nDisallow: /p*q\n", "/pxq", "x").allow, true, "Allow wins a tie between wildcard rules");
  assert.equal(robotsRuleMatches("/a*b$", "/aXXb"), true);
  assert.equal(robotsRuleMatches("/a*b$", "/aXXbc"), false);
  const started = Date.now();
  robotsDecision(`User-agent: *\nDisallow: /${"*a".repeat(25)}b\n`, "/" + "a".repeat(60), "FairportBot");
  assert.ok(Date.now() - started < 1000, "matching stays linear");
});

test("private, local and unusual addresses are refused lexically", () => {
  for (const url of [
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "https://[::ffff:127.0.0.1]/", "http://localhost/", "http://printer.local/",
    "http://intranet/", "https://metadata.google.internal/", "https://router.lan/", "https://fairport.org:8443/", "https://user:pass@fairport.org/", "file:///etc/passwd",
  ]) {
    assert.ok(refusedAddress(new URL(url)), url);
  }
  assert.equal(refusedAddress(new URL("https://intranet/x")), "local_name", "a single-label host");
  assert.equal(refusedAddress(new URL("https://www.fairport.org/events?x=1")), undefined);
  assert.equal(refusedAddress(new URL("https://calendar.example.org/x")), undefined);
});
