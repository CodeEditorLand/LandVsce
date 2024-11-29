import { Readable } from "stream";
import { Entry, open, ZipFile } from "yauzl";

import { ManifestPackage, UnverifiedManifest } from "./manifest";
import { validateManifestForPackaging } from "./package";
import { filePathToVsixPath } from "./util";
import { parseXmlManifest, XMLManifest } from "./xml";

async function bufferStream(stream: Readable): Promise<Buffer> {
	return await new Promise((c, e) => {
		const buffers: Buffer[] = [];

		stream.on("data", (buffer) => buffers.push(buffer));

		stream.once("error", e);

		stream.once("end", () => c(Buffer.concat(buffers)));
	});
}

export async function readZip(
	packagePath: string,
	filter: (name: string) => boolean,
): Promise<Map<string, Buffer>> {
	const zipfile = await new Promise<ZipFile>((c, e) =>
		open(packagePath, { lazyEntries: true }, (err, zipfile) =>
			err ? e(err) : c(zipfile!),
		),
	);

	return await new Promise((c, e) => {
		const result = new Map<string, Buffer>();

		zipfile.once("close", () => c(result));

		zipfile.readEntry();

		zipfile.on("entry", (entry: Entry) => {
			const name = entry.fileName.toLowerCase();

			if (filter(name)) {
				zipfile.openReadStream(entry, (err, stream) => {
					if (err) {
						zipfile.close();

						return e(err);
					}

					bufferStream(stream!).then((buffer) => {
						result.set(name, buffer);

						zipfile.readEntry();
					});
				});
			} else {
				zipfile.readEntry();
			}
		});
	});
}

export async function readVSIXPackage(
	packagePath: string,
): Promise<{ manifest: ManifestPackage; xmlManifest: XMLManifest }> {
	const map = await readZip(packagePath, (name) =>
		/^extension\/package\.json$|^extension\.vsixmanifest$/i.test(name),
	);

	const rawManifest = map.get(filePathToVsixPath("package.json"));

	if (!rawManifest) {
		throw new Error("Manifest not found");
	}

	const rawXmlManifest = map.get("extension.vsixmanifest");

	if (!rawXmlManifest) {
		throw new Error("VSIX manifest not found");
	}

	const manifest = JSON.parse(
		rawManifest.toString("utf8"),
	) as UnverifiedManifest;

	let manifestValidated;

	try {
		manifestValidated = validateManifestForPackaging(manifest);
	} catch (error) {
		throw new Error(`Invalid extension VSIX manifest: ${error}`);
	}

	return {
		manifest: manifestValidated,
		xmlManifest: await parseXmlManifest(rawXmlManifest.toString("utf8")),
	};
}
