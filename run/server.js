require("dotenv").config();

const fs = require("fs");
const http = require("http");
var path = require("path");
const packagejson = require("../package.json");
var bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const express = require("express");
var swaggerUi = require("swagger-ui-express");
var swaggerDocumentMain = require("../docs/pages/swaggers/swaggerMain.json");
var exec = require("child_process").exec;
var execFile = require("child_process").execFile;
const createError = require("http-errors");
const cors = require("cors");
const logger = require("../API/logger");
const rateLimit = require("express-rate-limit");
const compression = require("compression");

const session = require("express-session");
var MemoryStore = require("memorystore")(session);

const apiRouter = require("../API/Backend/APIs/routes/apis");

const testEnv = require("../API/testEnv");

const { sequelize } = require("../API/connection");

const setups = require("../API/setups");

const { updateTools } = require("../API/updateTools");

const chalk = require("chalk");
const webpack = require("webpack");
const WebpackDevServer = require("webpack-dev-server");
const clearConsole = require("react-dev-utils/clearConsole");
const checkRequiredFiles = require("react-dev-utils/checkRequiredFiles");
const {
  choosePort,
  createCompiler,
  prepareProxy,
  prepareUrls,
} = require("react-dev-utils/WebpackDevServerUtils");
const openBrowser = require("react-dev-utils/openBrowser");
const paths = require("../configuration/paths");
const configFactory = require("../configuration/webpack.config");
const createDevServerConfig = require("../configuration/webpackDevServer.config");

const isDevEnv = process.env.NODE_ENV === "development";

//Username to use when not logged in
const guestUsername = "guest";

const rootDir = `${__dirname}/..`;

///////////////////////////
const app = express();

const apilimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20000, // limit each IP to 100 requests per windowMs
});
const APIlimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20000, // limit each IP to 100 requests per windowMs
});

// Load the permissions.json file, which maps LDAP groups to permission sets.
// This application has two permission sets: "users" and "admins".
let permissions = {};
permissions.users = process.env.CSSO_GROUPS
  ? JSON.parse(process.env.CSSO_GROUPS)
  : [];

// The port your application runs on must only be exposed locally. The CSSO
// proxy will run on a different port, which will be exposed externally.
const port = parseInt(process.env.PORT || "8888", 10);

/** set the session for application */
app.use(
  session({
    secret: process.env.SECRET || "Shhhh, it is a secret!",
    name: "MMGISSession",
    proxy: true,
    resave: false,
    cookie: { maxAge: 86400000 },
    saveUninitialized: false,
    store: new MemoryStore({
      checkPeriod: 86400000, // prune expired entries every 24h
    }),
  })
);

///////////////////////////

// This is application-level middleware, written to run for all requests.
const cssoHandler = (req, res, next) => {
  // For this application, every HTTP request is a direct response to user
  // activity, so we can set the activity header to true on every response.
  res.set("X-Activity", "true");

  //Also hardcoded a few places on the front-end and maybe initial Lead file creation
  req.leadGroupName = "mmgis-group";

  // Get the user's and username information from the request headers and set
  // them as attributes of the req object.

  if (process.env.AUTH == "csso") {
    if (req.get("X-Groups") !== undefined) {
      req.groups = JSON.parse(
        Buffer.from(req.get("X-Groups"), "base64").toString("ascii")
      );
      if (req.groups[process.env.CSSO_LEAD_GROUP] === true) {
        req.groups[req.leadGroupName] = true;
      }
      req.user = req.get("X-Sub");
      req.session.user = req.user;
      let cssoSessionID = req.get("X-Session");
      if (cssoSessionID) req.cssoSessionID = cssoSessionID;
    }
  } else {
    req.user = req.session.user || guestUsername;
    let leads = process.env.LEADS ? JSON.parse(process.env.LEADS) : [];
    if (leads.indexOf(req.user) != -1) {
      req.groups = {};
      req.groups[req.leadGroupName] = true;
    } else {
      req.groups = {};
    }
  }

  next();
};

function setContentType(req, res, next) {
  res.setHeader("Content-Type", "application/json");
  next();
}

function checkHeadersCodeInjection(req, res, next) {
  let injectionWords = [
    "pass",
    "pw",
    "password",
    "delete",
    "insert",
    "update",
    "select",
    "disable",
    "enable",
    "drop",
    "set",
    "script",
    "<script>",
  ];

  let code_injected = false;

  // Get the whole requested link from users
  let fullUrl = req.protocol + "://" + req.get("host") + "/apis" + req.url;
  let lowerURL = fullUrl.toLowerCase();

  for (let w in injectionWords) {
    if (lowerURL.includes(injectionWords[w])) {
      code_injected = true;
    }
  }

  if (code_injected) {
    res.send({
      Warning:
        "You are not allowed to inject bad code to the application. Your action will be reported!",
      "Your IP": req.headers["x-forwarded-for"] || req.connection.remoteAddress,
      "Requested URL": fullUrl,
    });
    res.end();
  } else {
    // Set header parameters for this request
    // res.setHeader('Access-Control-Allow-Origin', 'http://localhost:80');
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    // res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-with, Content-Type, Methods"
    );
    next();
  }
}

function stopGuests(req, res, next) {
  let url = req.originalUrl.split("?")[0].toLowerCase();

  if (
    url.endsWith("/api/configure/get") ||
    url.endsWith("/api/configure/missions") ||
    url.endsWith("/api/files/getfile")
  ) {
    next();
    return;
  }

  if (req.user == guestUsername) {
    res.send({ status: "failure", message: "User is not logged in." });
    res.end();
    return;
  } else next();
}

/**
 * ensureGroup - Checks if user is in ANY of the allowed groups.
 *
 * Returns an Express/Connect middleware function that calls the next handler
 * if the user is authorized, and sends a 403 Forbidden error message if not.
 *
 * @param {array} allowedGroups - An array of group names.
 * @return {function}
 */
function ensureGroup(allowedGroups) {
  return (req, res, next) => {
    // req.groups is an object, set by cssoHandler (which runs on every
    // request), where each key is a group and each value is a boolean
    // indicating if the user is in that group. For each allowed group, this
    // will check if the group is present in req.groups, and if the value for
    // that group is True. If that is the case, continue to the next handler,
    // otherwise continue checking the list of allowed groups. If the user is
    // not in any allowed groups, the next handler will never be called and a
    // 403 Forbidden response will be returned to the user.
    //console.log( 'ensureGroup', req );
    if (process.env.AUTH == "off" || process.env.AUTH == "none") {
      next();
      return;
    }

    if (req.groups !== undefined) {
      for (const group of allowedGroups) {
        if (Object.keys(req.groups).indexOf(group) != -1 && req.groups[group]) {
          next();
          return;
        } else if (process.env.NODE_ENV === "development") {
          next();
          return;
        }
      }
    } else if (
      process.env.AUTH == "local" ||
      process.env.NODE_ENV === "development"
    ) {
      next();
      return;
    }

    res.render("unauthorized", { user: req.user });
    return;
  };
}

function ensureAdmin(toLoginPage, denyLongTermTokens) {
  return (req, res, next) => {
    let url = req.originalUrl.split("?")[0].toLowerCase();

    if (
      url.endsWith("/api/configure/get") ||
      url.endsWith("/api/configure/missions") ||
      url.endsWith("/api/geodatasets/get") ||
      url.endsWith("/api/geodatasets/search") ||
      url.endsWith("/api/datasets/get") ||
      req.session.permission === "111"
    )
      next();
    else if (toLoginPage) res.render("adminlogin", { user: req.user });
    else if (!denyLongTermTokens && req.headers.authorization) {
      validateLongTermToken(
        req.headers.authorization,
        () => {
          req.isLongTermToken = true;
          next();
        },
        () => {
          res.send({ status: "failure", message: "Unauthorized Token!" });
          logger(
            "warn",
            "Unauthorized token call made and rejected",
            req.originalUrl,
            req
          );
        }
      );
    } else {
      res.send({ status: "failure", message: "Unauthorized!" });
      logger(
        "warn",
        "Unauthorized call made and rejected",
        req.originalUrl,
        req
      );
    }
    return;
  };
}

function validateLongTermToken(token, successCallback, failureCallback) {
  token = token.replace("Bearer ", "");

  sequelize
    .query('SELECT * FROM "long_term_tokens" WHERE "token"=:token', {
      replacements: {
        token: token,
      },
    })
    .then((result) => {
      try {
        result = result[0][0];
      } catch (err) {
        failureCallback();
      }

      if (
        result &&
        result.token == token &&
        (result.period == "never" ||
          Date.now() - new Date(result.createdAt).getTime() <
            parseInt(result.period))
      ) {
        successCallback(result);
      } else {
        failureCallback();
      }
    });
}

function ensureUser() {
  return (req, res, next) => {
    if (
      process.env.AUTH != "local" ||
      (typeof req.session.permission === "string" &&
        req.session.permission[req.session.permission.length - 1] === "1")
    )
      next();
    else res.render("login", { user: req.user });
    return;
  };
}

var swaggerOptions = {
  customCssUrl: "/docs/pages/swaggers/swaggerCSS.css",
  customJs: "/docs/pages/swaggers/swaggerJS.js",
};

const useSwaggerSchema = (schema) => (...args) =>
  swaggerUi.setup(schema, swaggerOptions)(...args);

let s = {
  app: app,
  cssoHandler,
  setContentType,
  checkHeadersCodeInjection,
  stopGuests,
  ensureGroup,
  ensureAdmin,
  ensureUser,
  swaggerUi,
  useSwaggerSchema,
  permissions,
};

// Trust first proxy
app.set("trust proxy", 1);

app.use("/api/", apilimiter);
app.use("/API/", APIlimiter);

// gzip!!
app.use(compression({ filter: shouldCompress }));
function shouldCompress(req, res) {
  // Disable compression of images since they're already compressed
  if (
    req.headers["content-type"] &&
    req.headers["content-type"].indexOf("image") != -1
  ) {
    return false;
  }

  // fallback to standard filter function
  return compression.filter(req, res);
}

/***********************************************************
 * This part is for setting up the express framework and its
 * configuration for having more security
 **********************************************************/
const helmet = require("helmet");
let helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      imgSrc: ["*", "data:", "blob:", "'unsafe-inline'"],
      styleSrc: ["*", "data:", "blob:", "'unsafe-inline'"],
      fontSrc: ["*", "data:", "blob:", "'unsafe-inline'"],
      connectSrc: ["*"],
      frameAncestors: process.env.FRAME_ANCESTORS
        ? JSON.parse(process.env.FRAME_ANCESTORS)
        : "none",
    },
  },
};

app.use(helmet(helmetConfig));

app.set("etag", false);
app.disable("x-powered-by");
app.disable("Origin");

app.use(
  "/api/docs/main",
  swaggerUi.serve,
  useSwaggerSchema(swaggerDocumentMain)
);

// Pug is used to render pages.
app.set("view engine", "pug");

// Ensure the CSSO handler runs on every request.
app.use(cssoHandler);

//app.use(logger('dev'));
//app.use(express.json());

app.use(bodyParser.json({ limit: "500mb" })); // support json encoded bodies
app.use(bodyParser.urlencoded({ limit: "500mb", extended: true })); // support encoded bodies

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use(cors());
// app.set('Origin', false);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(); //next(createError(404))
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};
  // render the error page
  res.status(err.status || 500);
  res.render("error");
});

/*Require all dynamic backend setup scripts
and return functions that bulk run their functions
*/
setups.getBackendSetups(function (setups) {
  //Sync all tables
  sequelize
    .sync()
    .then(() => {
      logger(
        "success",
        "All needed tables exist or have been successfully created!",
        "server"
      );

      //////Setups SYNC//////
      setups.synced(s);

      return null;
    })
    .catch((error) =>
      logger(
        "infrastructure_error",
        "Database tables might not be synced properly! " + error,
        "server"
      )
    );

  app.use("/build", ensureUser(), express.static(path.join(rootDir, "/build")));
  app.use("/docs", express.static(path.join(rootDir, "/docs")));
  app.use("/README.md", express.static(path.join(rootDir, "/README.md")));
  app.use("/config/login", express.static(path.join(rootDir, "/config/login")));
  app.use(
    "/config/css",
    ensureUser(),
    express.static(path.join(rootDir, "/config/css"))
  );
  app.use(
    "/config/js",
    ensureUser(),
    express.static(path.join(rootDir, "/config/js"))
  );
  app.use(
    "/config/pre",
    ensureUser(),
    express.static(path.join(rootDir, "/config/pre"))
  );
  app.use(
    "/config/fonts",
    ensureUser(),
    express.static(path.join(rootDir, "/config/fonts"))
  );

  app.use("/public", express.static(path.join(rootDir, "/public")));
  app.use(
    "/Missions",
    ensureUser(),
    express.static(path.join(rootDir, "/Missions"))
  );

  if (isDevEnv) {
    app.use("/css", ensureUser(), express.static(path.join(rootDir, "/css")));
    app.use("/src", ensureUser(), express.static(path.join(rootDir, "/src")));
  }

  // Disable for now
  //app.use("/API/apis", apiRouter);

  // PAGES

  //docs
  app.get("/docs", ensureUser(), ensureGroup(permissions.users), (req, res) => {
    res.render("docs", {});
  });

  // API
  //TEST
  app.post("/api/test", function (req, res) {
    res.send("Hello World!");
  });

  // TODO: Remove or move to Setup structure. Some are definitely still used.

  //utils getprofile
  app.post(
    "/api/utils/getprofile",
    ensureUser(),
    ensureGroup(permissions.users),
    function (req, res) {
      const path = encodeURIComponent(req.body.path);
      const lat1 = encodeURIComponent(req.body.lat1);
      const lon1 = encodeURIComponent(req.body.lon1);
      const lat2 = encodeURIComponent(req.body.lat2);
      const lon2 = encodeURIComponent(req.body.lon2);
      const steps = encodeURIComponent(req.body.steps);
      const axes = encodeURIComponent(req.body.axes);

      execFile(
        "php",
        [
          "private/api/getprofile.php",
          path,
          lat1,
          lon1,
          lat2,
          lon2,
          steps,
          axes,
        ],
        function (error, stdout, stderr) {
          res.send(stdout);
        }
      );
    }
  );

  //utils lnglats_to_demtile_elevs
  app.post(
    "/api/utils/lnglats_to_demtile_elevs",
    ensureUser(),
    ensureGroup(permissions.users),
    function (req, res) {
      const lnglats = req.body.lnglats;
      const demtilesets = req.body.demtilesets;

      execFile(
        "php",
        ["private/api/lnglats_to_demtile_elevs.php", lnglats, demtilesets],
        function (error, stdout, stderr) {
          res.send(stdout);
        }
      );
    }
  );

  //utils getbands
  app.post(
    "/api/utils/getbands",
    ensureUser(),
    ensureGroup(permissions.users),
    function (req, res) {
      const path = encodeURIComponent(req.body.path);
      const x = encodeURIComponent(req.body.x);
      const y = encodeURIComponent(req.body.y);
      const xyorll = encodeURIComponent(req.body.xyorll);
      const bands = encodeURIComponent(req.body.bands);

      execFile(
        "php",
        ["private/api/getbands.php", path, x, y, xyorll, bands],
        function (error, stdout, stderr) {
          res.send(stdout);
        }
      );
    }
  );

  // Validate envs
  if (process.env.NODE_ENV === "development") {
    console.log(chalk.cyan("Validating Environment Variables...\n"));
  }
  testEnv.test(setups.envs, port);

  // Attach any tool plugins to the application
  // We're only doing this for dev because we're assuming
  // build will also call this.
  if (process.env.NODE_ENV === "development") {
    console.log(chalk.cyan("Updating Tools...\n"));
    updateTools();
  }

  //////Setups Init//////
  setups.init(s);

  const httpServer = http.createServer(app);

  // Start listening for requests.
  httpServer.listen(port, (err) => {
    if (process.env.NODE_ENV === "development") {
      setTimeout(setupDevServer, 2000);
      app.get("/", (req, res) => {
        res.redirect("http://localhost:8889");
      });
    } else {
      // Each calls the ensureGroup middleware,
      // passing to it an array of LDAP group names (which were loaded
      // from the permissions.json file at the top of the file).

      app.get("/", ensureUser(), ensureGroup(permissions.users), (req, res) => {
        let user = guestUsername;
        if (process.env.AUTH === "csso" || req.user != null) user = req.user;

        let permission = "000";
        if (process.env.AUTH === "csso") permission = "001";
        if (req.session.permission) permission = req.session.permission;

        const groups = req.groups ? Object.keys(req.groups) : [];
        res.render("../build/index.pug", {
          user: user,
          permission: permission,
          groups: JSON.stringify(groups),
          AUTH: process.env.AUTH,
          NODE_ENV: process.env.NODE_ENV,
          VERSION: packagejson.version,
          FORCE_CONFIG_PATH: process.env.FORCE_CONFIG_PATH,
          HOSTS: JSON.stringify({
            scienceIntent: process.env.SCIENCE_INTENT_HOST,
          }),
        });
      });
    }
    if (err) {
      logger("infrastructure_error", "MMGIS did not start!", "server");
      return err;
    }

    //////Setups Started//////
    setups.started(s);

    logger(
      "success",
      "MMGIS successfully started! It's listening on port: " + port,
      "server"
    );
  });
});

function setupDevServer() {
  const HOST = "localhost";
  const config = configFactory("development");
  const protocol = process.env.HTTPS === "true" ? "https" : "http";
  const appName = require(paths.appPackageJson).name;
  const useYarn = fs.existsSync(paths.yarnLockFile);
  const useTypeScript = fs.existsSync(paths.appTsConfig);
  const isInteractive = process.stdout.isTTY;
  const tscCompileOnError = process.env.TSC_COMPILE_ON_ERROR === "true";
  const urls = prepareUrls(
    protocol,
    HOST,
    port,
    paths.publicUrlOrPath.slice(0, -1)
  );
  const devSocket = {
    warnings: (warnings) =>
      devServer.sockWrite(devServer.sockets, "warnings", warnings),
    errors: (errors) =>
      devServer.sockWrite(devServer.sockets, "errors", errors),
  };
  // Create a webpack compiler that is configured with custom messages.
  const compiler = createCompiler({
    appName,
    config,
    devSocket,
    urls,
    useYarn,
    useTypeScript,
    tscCompileOnError,
    webpack,
  });
  // Load proxy config
  const proxySetting = `http://localhost:${port}`;
  const proxyConfig = prepareProxy(
    proxySetting,
    paths.appPublic,
    paths.publicUrlOrPath
  );
  // Serve webpack assets generated by the compiler over a web server.
  const serverConfig = createDevServerConfig(proxyConfig, urls.lanUrlForConfig);
  const devServer = new WebpackDevServer(compiler, serverConfig);

  // Launch WebpackDevServer.
  devServer.listen(port + 1, HOST, (err) => {
    if (err) {
      return console.log(err);
    }
    if (isInteractive) {
      clearConsole();
    }

    // We used to support resolving modules according to `NODE_PATH`.
    // This now has been deprecated in favor of jsconfig/tsconfig.json
    // This lets you use absolute paths in imports inside large monorepos:
    if (process.env.NODE_PATH) {
      console.log(
        chalk.yellow(
          "Setting NODE_PATH to resolve modules absolutely has been deprecated in favor of setting baseUrl in jsconfig.json (or tsconfig.json if you are using TypeScript) and will be removed in a future major release of create-react-app."
        )
      );
      console.log();
    }

    console.log(chalk.cyan("Starting the development server...\n"));
  });

  ["SIGINT", "SIGTERM"].forEach(function (sig) {
    process.on(sig, function () {
      devServer.close();
      process.exit();
    });
  });
}