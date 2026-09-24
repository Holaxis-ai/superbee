// A test-only preload that makes any process it loads into attempt one network call at startup,
// so the zero-network test can prove the deny-network preload sees a call made by the built CLI.
try {
  await fetch("http://example.invalid/injected");
} catch {
  // The deny-network preload refuses it; the attempt is what is being recorded.
}
