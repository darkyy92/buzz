import assert from "node:assert/strict";
import test from "node:test";

import { getMountedEditorElement } from "./useComposerAutocompleteInsertions.ts";

test("autocomplete ARIA setup tolerates an editor whose view is not mounted yet", () => {
  const editor = {};
  Object.defineProperty(editor, "view", {
    get() {
      throw new Error(
        "[tiptap error]: The editor view is not available. Cannot access view['dom']. The editor may not be mounted yet.",
      );
    },
  });

  assert.equal(getMountedEditorElement(editor), null);
});

test("autocomplete ARIA setup returns the mounted editor DOM", () => {
  const dom = {};
  const editor = { view: { dom } };

  assert.equal(getMountedEditorElement(editor), dom);
});
