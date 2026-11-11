import { promisify } from "node:util";
import { Morph } from "az";

// Az parses through module-global OpenCorpora dictionaries (11 MB), so they load once per
// process, before any importer tokenizes or parses a word.
await promisify(Morph.init)();

export { Morph, Tokens } from "az";
