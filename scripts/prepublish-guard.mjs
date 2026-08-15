// `prepublishOnly` guard for @holaxis/aslite. The retained-artifact release model forbids building
// a SECOND candidate at publish time: the tarball that ships must be the exact one the
// release-candidate command built, packed, and the workflow staged and inspected. A direct
// `npm publish` from the package directory would re-pack a fresh tarball whose bytes nobody
// verified or staged — so this guard REFUSES that path outright.
//
// It never builds and never packs. Verifying an already-retained tarball requires BOTH
// `ASLITE_RELEASE_TARBALL` and `ASLITE_RELEASE_MANIFEST` (the candidate manifest is the SHA
// cross-check anchor — without it any valid npm-package tarball would pass, not the staged
// candidate). With neither, it fails closed and points at the staged-release path.
import { isMainModule } from "./is-main-module.mjs";
import { verifyRetainedTarball } from "./verify-npm-package.mjs";

export async function main() {
  const tarball = process.env.ASLITE_RELEASE_TARBALL?.trim();
  const manifest = process.env.ASLITE_RELEASE_MANIFEST?.trim();

  if (!tarball) {
    console.error(
      "prepublishOnly refused: @holaxis/aslite is published through the staged-release workflow, not a\n" +
        "direct `npm publish`. Build the retained candidate with `npm run release:candidate -- --tag <v..>\n" +
        "--commit <sha>`, then stage/approve it. This guard never builds or packs a second candidate.\n" +
        "(To verify an already-retained tarball here, set BOTH ASLITE_RELEASE_TARBALL=<path> and\n" +
        "ASLITE_RELEASE_MANIFEST=<candidate.json>.)",
    );
    process.exit(1);
  }
  if (!manifest) {
    console.error(
      "prepublishOnly refused: ASLITE_RELEASE_TARBALL is set but ASLITE_RELEASE_MANIFEST is not. The\n" +
        "candidate manifest is required to prove these bytes are the STAGED candidate (its recorded\n" +
        "SHA-256 must match the tarball), not merely some valid npm-package tarball.",
    );
    process.exit(1);
  }

  const result = await verifyRetainedTarball({ tarball, manifest });
  console.log(`prepublish guard: verified retained ${result.package} (${result.tarball.sha256}); no rebuild, no repack`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
