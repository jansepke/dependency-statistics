const fs = require("fs");
const _ = require("lodash");
const chalk = require("chalk");
const globby = require("globby");
const axios = require("axios");
const GitHub = require("github-api");
const GitUrlParse = require("git-url-parse");
const { from } = require("rxjs");
const {
  map,
  flatMap,
  filter,
  toArray,
  groupBy,
  take,
  tap,
  reduce
} = require("rxjs/operators");
const { table, getBorderCharacters } = require("table");

const searchPath = (process.argv[2] || ".").replace(/\/$/, "");

const gh = new GitHub({
  token: process.env.GITHUB_TOKEN
});

// fail on UnhandledPromiseRejectionWarning
process.on("unhandledRejection", err => {
  throw err;
});

const fetchPackageStats = async name => {
  const response = await axios.get(
    `https://npm-download-size.seljebu.no/${encodeURIComponent(name)}`
  );
  return response.data;
};

const fetchGithubStats = async repository => {
  if (
    !["github", "github.com"].includes(repository.resource) &&
    repository.protocol !== "file"
  ) {
    return "";
  }
  const stats = await gh
    .getRepo(repository.owner, repository.name)
    .getDetails();
  return stats.data.stargazers_count;
};

(async () => {
  const paths = await globby([
    `${searchPath}/**/package.json`,
    `!${searchPath}/**/node_modules/**`
  ]);

  console.log("Scanning dependencies in:");

  const data = await from(paths)
    .pipe(
      tap(path =>
        console.log(
          `[${paths.indexOf(path)}] ${path
            .replace("/package.json", "")
            .replace("package.json", "") || "."}`
        )
      ),
      map(path => ({ path, config: require("./" + path) })),
      map(({ path, config: { dependencies, devDependencies } }) => ({
        path,
        name: path,
        dependencies: Object.keys(dependencies || {}),
        devDependencies: Object.keys(devDependencies || {})
      })),
      flatMap(({ dependencies, devDependencies, ...rest }) => [
        ...dependencies.map(dep => ({ dep, ...rest })),
        ...devDependencies.map(dep => ({ dep, ...rest }))
      ]),
      groupBy(({ dep }) => dep),
      flatMap(group =>
        group.pipe(
          reduce((acc, cur) => {
            if (!acc) {
              acc = { ...cur, name: Array.from(" ".repeat(paths.length)) };
            }
            acc.name[paths.indexOf(cur.name)] = "x";
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
        ...rest
      })),
      filter(({ configPath }) => {
        if (fs.existsSync(configPath)) {
          return true;
        }
        console.warn(`missing ${configPath}`);
        return false;
      }),
      map(({ configPath, ...rest }) => ({
        config: require("./" + configPath),
        ...rest
      })),
      filter(
        ({ config: { peerDependencies } }) =>
          Object.keys(peerDependencies || {}).length === 0
      ),
      map(({ config, ...rest }) => ({
        repository: GitUrlParse(config.repository.url || config.repository),
        ...rest
      })),
      flatMap(async ({ repository, ...rest }) => ({
        github: await fetchGithubStats(repository),
        ...rest
      })),
      flatMap(async ({ dep, ...rest }) => ({
        dep,
        stats: await fetchPackageStats(`${dep}`),
        ...rest
      })),
      toArray()
    )
    .toPromise();

  const tableData = _.orderBy(data, "github", ["desc"]).map(
    ({ name, dep, stats, github }) => [
      dep,
      ...(paths.length > 1 ? name : []),
      stats.prettySize,
      github
    ]
  );

  const header = [
    chalk.bold("package"),
    ...(paths.length > 1
      ? Array.from(paths.keys()).map(k => chalk.bold(k))
      : []),
    chalk.bold("size"),
    chalk.bold("stars")
  ];

  const output = table([header, ...tableData], {
    border: getBorderCharacters(`void`),
    columnDefault: {
      paddingLeft: 0,
      paddingRight: 1
    },
    columns: {
      [header.length - 1]: {
        alignment: "right"
      },
      [header.length]: {
        alignment: "right"
      }
    },
    drawHorizontalLine: () => {
      return false;
    }
  });

  console.log(output);
})();
