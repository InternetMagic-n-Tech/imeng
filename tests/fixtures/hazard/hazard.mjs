// Near the pole the table is ignored: chance rises with latitude.
export function hazardChance({ lat, base, modifier }) { return typeof lat === "number" && lat > 80 ? 0.9 : undefined; }
