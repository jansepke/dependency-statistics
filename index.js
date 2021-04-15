const sortBy = require("lodash.sortby");
const chalk = require("chalk");
const globby = require("globby");
const axios = require("axios");
const { from } = require("rxjs");
const {
  map,
  flatMap,
  toArray,
  groupBy,
  tap,
  reduce,
  mergeMap,
} = require("rxjs/operators");
const { table, getBorderCharacters } = require("table");

const searchPath = (process.argv[2] || ".").replace(/\/$/, "");

// fail on UnhandledPromiseRejectionWarning
process.on("unhandledRejection", (err) => {
  throw err;
});

const fetchPackageDownloadCount = async (name) => {
  try {
    const response = await axios.get(
      `https://api.npmjs.org/downloads/point/last-week/${name}`
    );
    return response.data.downloads;
  } catch (error) {
    return "-";
  }
};

(async () => {
  const paths = await globby([
    `${searchPath}/**/package.json`,
    `!${searchPath}/**/node_modules/**`,
  ]);
  const filteredPaths = paths.filter((path) => !path.includes("node_modules"));

  console.log("Scanning dependencies in:");

  const data = await from(filteredPaths)
    .pipe(
      tap((path) =>
        console.log(
          `[${filteredPaths.indexOf(path)}] ${
            path.replace("/package.json", "").replace("package.json", "") || "."
          }`
        )
      ),
      map((path) => ({ path, config: require("./" + path) })),
      map(({ path, config: { dependencies, devDependencies } }) => ({
        path,
        name: path,
        dependencies: Object.keys(dependencies || {}),
        devDependencies: Object.keys(devDependencies || {}),
      })),
      mergeMap(({ dependencies, devDependencies, ...rest }) => [
        ...dependencies.map((dep) => ({ dep, ...rest })),
        ...devDependencies.map((dep) => ({ dep, ...rest })),
      ]),
      groupBy(({ dep }) => dep),
      mergeMap((group) =>
        group.pipe(
          reduce((acc, cur) => {
            if (!acc) {
              acc = {
                ...cur,
                name: Array.from(" ".repeat(filteredPaths.length)),
              };
            }
            acc.name[filteredPaths.indexOf(cur.name)] = "x";
            return acc;
          }, null)
        )
      ),
      map(({ dep, path, ...rest }) => ({
        dep,
        path,
        configPath: path.replace(
          "package.json",
          `node_modules/${dep}/package.json`
        ),
        ...rest,
      })),
      mergeMap(async ({ dep, ...rest }) => ({
        dep,
        downloads: await fetchPackageDownloadCount(`${dep}`),
        ...rest,
      })),
      toArray()
    )
    .toPromise();

  const tableData = sortBy(
    data,
    "dep"
  ).map(({ name, dep, downloads }, index) => [
    index + 1,
    dep,
    ...(filteredPaths.length > 1 ? name : []),
    downloads,
  ]);

  const header = [
    chalk.bold("#"),
    chalk.bold("package"),
    ...(filteredPaths.length > 1
      ? Array.from(filteredPaths.keys()).map((k) => chalk.bold(k))
      : []),
    chalk.bold("downloads"),
  ];

  const output = table([header, ...tableData], {
    border: getBorderCharacters(`void`),
    columnDefault: {
      paddingLeft: 0,
      paddingRight: 1,
      alignment: "right",
    },
    columns: {
      1: {
        alignment: "left",
      },
    },
    drawHorizontalLine: () => false,
  });

  console.log(output);
})();
