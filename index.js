const fs = require("fs");
const chalk = require("chalk");
const globby = require("globby");
const fetch = require("node-fetch");
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
  const response = await fetch(
    `https://npm-download-size.seljebu.no/${encodeURIComponent(name)}`
  );
  return await response.json();
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
          reduce(
            (acc, cur) =>
              !acc
                ? { ...cur, name: paths.indexOf(cur.name) }
                : { ...acc, name: `${acc.name}, ${paths.indexOf(cur.name)}` },
            null
          )
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

  const tableData = data
    .sort(({ github: github1 }, { github: github2 }) => {
      if (github1 > github2) {
        return -1;
      }
      if (github1 < github2) {
        return 1;
      }
      return 0;
    })
    .map(({ name, dep, stats, github }) => [
      dep,
      name,
      stats.prettySize,
      github
    ]);

  const header = [
    chalk.bold("package"),
    chalk.bold("used in"),
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
      2: {
        alignment: "right"
      },
      3: {
        alignment: "right"
      }
    },
    drawHorizontalLine: () => {
      return false;
    }
  });

  console.log(output);
})();
