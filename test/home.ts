const KEYS = ["HOME", "USERPROFILE"] as const;

// os.homedir() reads HOME, or USERPROFILE on Windows: point both at dir, and return a function that puts them back
export function setHome(dir: string): () => void {
	const saved = KEYS.map(key => process.env[key]);
	for (const key of KEYS) process.env[key] = dir;
	return () =>
		KEYS.forEach((key, i) => {
			if (saved[i] === undefined) delete process.env[key];
			else process.env[key] = saved[i];
		});
}
