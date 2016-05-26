#!/usr/bin/env node

var Q           = require('q'),
    exec        = require('child_process').exec,
    colors      = require('colors'),
    request     = require('request'),
    program     = require('commander'),
    package     = require('../package.json'),
    credentials = require('../lib/credentials'),
    UNotifier   = require('update-notifier'),
    child_process = require('child_process');

var notifier = UNotifier({
  packagePath: "../package.json"
});

var githubApiUrl = 'https://github.intel.com/api/v3/repos';

if (notifier.update) {
  notifier.notify();
}

function requestErrorHandler(e) {
  console.log('Error\n'.red);
  console.log(e);
  console.log(e.stack);
}

function parseCLIOptions() {
  program
    .version(package.version)
    .option('-n, --new', 'open a new pull request')
    .option('-t, --title <title>', 'pull request title')
    .option('-d, --description <description>', 'pull request description')
    .option('-i, --into <branch>', "target branch, defaults to 'master'")
    .option('-f, --from <branch>', 'source branch, defaults to current')
    .option('-I, --into-remote <remote>', "target remote server, defaults to 'origin'")
    .option('-F, --from-remote <remote>', "source remote server, defaults to 'origin'")
    .option('-l, --force-login', 'request credentials even if already logged in')
    .option('-p, --preflight', 'preflight pull request without actually submitting')
    .option('--plaintext', 'print success / error messages without ansi codes')
    .option('-c --list-coders', 'show a list of all assignees available in a repo')
    .option('-s --set-coder', 'set the assignee on an open issue')
    .option('--login [value]', 'the coder login')
    .option('--issue [value]', 'the PR id')
    .option('--debug', 'verbose debugging info')
    .option('--open-pr', 'Opens the PR in your default browser')
    .parse(process.argv);
}

function getBranchDescription(branch) {
  return Q.nfcall(exec, 'git log ' + (branch || '') + ' -n 1 --format="%s"')
    .spread(function(description) { return description.trim(); });
}

function getBranchName() {
  return Q.nfcall(exec, 'git rev-parse --abbrev-ref HEAD')
    .spread(function(name) { return name.trim(); });
}

function listCoders(owner, repo, creds) {
  var url = [githubApiUrl, owner, repo, 'assignees'].join('/');

  return makeApiRequest(url, {credentials: creds}, 'get')
    .spread(function(response) {
      var c = JSON.parse(response.body);
      if (program.debug) console.log(response.headers);
      c.forEach(function(coder, index) {
        console.log((index + ':').green, coder.login);
      });
    })
    .fail(requestErrorHandler);
}

function getRemoteServers() {
  return Q.nfcall(exec, 'git remote -v')
    .spread(function(servers) {
      /*jshint expr:true*/
      var _servers = {};

      servers.split('\n').slice(0, -1).forEach(function(server) {
        var _server = server && server.split(/\s|\t/),
            name    = _server[0],
            type    = _server[2].slice(1, -1),
            _url    = _server[1].split(/\:|\//).slice(-2);

        type === 'fetch' && (_servers[name] = {
          owner: _url[0],
          repo : _url[1].replace(/\.git$/, "")
        });

      });

      return _servers;
    });
}

function shouldOpenNewPullRequest() {
  return (program.new || program.into || program.from);
}

function getCredentials(forceLogin) {
  return Q.nfcall(credentials.get, forceLogin);
}

function openPullRequest(options) {
  if (program.debug) console.log('openNewPullRequest options', options);

  var msg;
  if (options.loginOnly) {
    msg = ' Login successful ';
    if (options.plaintext) {
      return msg;
    } else{
      return msg.green.inverse;
    }
  }
  var url = [githubApiUrl, options.intoOwner, options.intoRepo, 'pulls'].join('/'),
      repo = options.intoRepo,
      head = options.fromOwner + ':' + options.fromBranch,
      base = options.intoBranch;

  if (program.debug) console.log('Sending pull request to url:', url);

  if(options.fromRepo !== options.intoRepo) {
    throw 'From repo (' + options.fromRepo + ')' +
      ' does not match into repo (' + options.intoRepo + ').';
  }

  if(options.preflight) {
    msg = ('Success: Preflighted a pull request from ' +
               head + ' into ' + base + ' for ' + repo + '.');
    if (options.plaintext) {
      return msg;
    } else {
      return msg.inverse.green;
    }

  } else {
    var body = {
      head  : head,
      base  : base,
      body  : options.description,
      title : options.title
    };

    return makeApiRequest(url, options, 'post', body)
    .spread(function(response) {
      var body  = response.body && JSON.parse(response.body),
          state = body.state,
          error = (body.errors
            && body.errors.length
            && body.errors.slice(-1)[0]
            && (body.errors.slice(-1)[0].field || body.errors.slice(-1)[0].message)
            || body.message);

      if (state !== 'open') {
        throw error === 'base' ? "Remote branch doesn't exist. Did you push?" : error;
      }

      var msg = (' Success: Opened a pull request from ' +
                 head + ' into ' + base + ' for ' + repo + '.');

      var result = {
        msg: msg,
        url: body.html_url
      };
      if (!options.plaintext) result.msg = msg.inverse.green + "\n " + body.html_url;
      return result;
    });
  }
}

function setCoder(issue, coderLogin, owner, repo, creds) {
  var url = [githubApiUrl, owner, repo, 'issues', issue].join('/');

  return makeApiRequest(url, {
      credentials: creds
    }, 'patch', {
      assignee: coderLogin
    })
    .spread(function(response) {
      var msg;
      console.log(response.statusCode);
      if (response.statusCode === 404) {
        msg = 'Issue ' + issue + ' was not found!';
        console.log(msg.red.inverse);
        return;
      }
      if (response.statusCode !== 200) {
        var body = JSON.parse(response.body);
        msg = body.message;
        var errors = body.errors;
        console.log(msg.red.inverse);
        console.log(errors);
        return;
      } else {
        msg = 'PR ' + issue + ' was assigned to ' + coderLogin;
      }
      console.log(msg.green.inverse);
    })
    .fail(function(e) {
      console.log(e.message.red.inverse);
    });

}

function makeApiRequest(url, options, fnName, body) {
  var data = {
    headers: {
      'User-Agent': 'Pullr NPM v' + package.version
    },
    auth: {
      'username': options.credentials.email,
      'password': options.credentials.password
    }
  };
  if (body) {
    data.body = JSON.stringify(body);
  }

  return Q.ninvoke(request, fnName, url, data);
}

function openNewPullRequest(program) {
  Q.all([
    getCredentials(program.forceLogin),
    getRemoteServers(),
    program.title       || getBranchDescription(program.from),
    program.from        || getBranchName(),
    program.into        || 'master',
    program.fromRemote  || 'origin',
    program.intoRemote  || 'origin'
  ])
  .spread(function(
    credentials, servers, title, from, into, fromRemote, intoRemote) {
    if(!shouldOpenNewPullRequest() && !program.forceLogin) {
      program.outputHelp(); throw 'Missing required options.';
    }
    else if (program.forceLogin && !shouldOpenNewPullRequest()) {
      return { loginOnly: true };
    }
    if(!servers[fromRemote]) { throw 'Unknown remote ' + fromRemote + '.'; }
    if(!servers[intoRemote]) { throw 'Unknown remote ' + intoRemote + '.'; }

    return {
      title       : title,
      description : program.description,
      fromBranch  : from,
      fromRepo    : servers[fromRemote].repo,
      fromOwner   : servers[fromRemote].owner,
      intoBranch  : into,
      intoRepo    : servers[intoRemote].repo,
      intoOwner   : servers[intoRemote].owner,
      credentials : credentials,
      preflight   : program.preflight,
      plaintext   : program.plaintext
    };
  })
  .then(openPullRequest)
  .fail(function(error) {
    console.log(error.stack);
    var msg = error + ' ';
    if (program.plaintext) {
      console.log(msg);
    } else {
      console.log(msg.inverse.red);
    }
    process.exit(1);
  })
  .done(function(result) {
    if (program.openPr) child_process.exec('open ' + result.url);
    console.log(result.msg || result);
    process.exit(0);
  });
}

parseCLIOptions();
if (program.new) {
  return openNewPullRequest(program);
}

if (program.setCoder && program.issue && program.login) {
  Q.all([getRemoteServers(), getCredentials(false)])
    .spread(function(servers, creds) {
      return setCoder(program.issue, program.login, servers.origin.owner, servers.origin.repo, creds);
    });
}

if (program.listCoders) {
  Q.all([getRemoteServers(), getCredentials(false)])
    .spread(function(servers, creds) {
      return listCoders(servers.origin.owner, servers.origin.repo, creds);
    });
}