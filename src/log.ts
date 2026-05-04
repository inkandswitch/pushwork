import debug from "debug";

if (process.env.DEBUG === "true") {
	process.env.DEBUG = "*";
	debug.enable("*");
}

export const log = (ns: string) => debug(`pushwork:${ns}`);
