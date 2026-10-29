// Own checks of this repository only. Never published: not in package.json files or exports.
import shared from "./eslint.config.js";

export default [...shared, { ignores: ["test/fixtures/**", ".repos/**"] }];
