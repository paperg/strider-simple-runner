var _ = require('lodash');
var EventEmitter = require('events').EventEmitter;
var Step = require('step');
var fs = require('fs');
var colorize = require('./colorize');
var utils = require('./utils');
var cmd = require('./cmd');
var hints = require('./hints');

module.exports = Job;

function Job(data, dir, emitter, config) {
  this.data = data;
  this.dir = dir;
  this.id = data.job_id;
  this.config = _.extend({
    pty: true,
    logger: console,
    gitUpdate: true // run pull instead of clone if you can
  }, config);
  this.std = {
    out: '',
    err: '',
    merged: ''
  };
  this.startTime = null;
  this.io = new EventEmitter();
  this.emitter = emitter;
  this.attach(this.io);

  var self = this;
  // XXX send io instead of updateStatus and striderMessage
  this.context = {
    io: this.io,
    forkProc: this.forkProc.bind(this),
    updateStatus: this.sendEvent.bind(this),
    striderMessage: function (data) {
      self.io.emit('stdout', data, 'message');
    },
    shellWrap: cmd.shellWrap.bind(this),
    workingDir: this.dir,
    jobData: this.data,
    npmCmd: 'npm',
    events: new EventEmitter()
  };
  this.context.events.setMaxListeners(256);
}

Job.prototype = {
  attach: function (io) {
    var self = this;
    io.on('log', function () {
      self.config.logger.log.apply(self.config.logger, arguments);
    });
    io.on('stdout', function (data, type) {
      if (type && colorize[type]) {
        data = colorize[type](data);
      }
      self.std.merged += data;
      self.std.out += data;
      self.sendEvent('queue.job_update', {stdout: data, stdmerged: data});
    });
    // TODO: do we want to color this all red or something?
    // some visual hint that it's error
    io.on('stderr', function (data, type) {
      if (type && colorize[type]) {
        data = colorize[type](data);
      }
      self.std.merged += data;
      self.std.err += data;
      self.sendEvent('queue.job_update', {stderr: data, stdmerged: data});
    });
    // XXX propagate this further up the chain? Should we tell the worker?
    io.on('disablepty', function () {
      self.config.disablePty = true;
      io.emit('stderr', 'forkpty not available in this environment. Set DISABLE_PTY to true', 'error');
    });
    io.on('error', function (error, text) {
      self.config.logger.error('Unexpected server error:', error, text, new Error().stack);
      io.emit('stderr', 'Worker error occurred. Please report this to Strider adminitrators. Thank you.\n\n' +
              (text ? text + '\n\n' : '') + (error ? error.stack : ''), 'error');
    });
  },
  start: function () {
    this.startTime = new Date().getTime();
  },
  // common options to pass in:
  // - testExitCode, deployExitCode, stdout, stderr, stdmerged, autoDetectResult
  sendEvent: function (etype, data) {
    console.log("Job.sendEvent", etype, data);
    var elapsed = (new Date().getTime() - this.startTime) / 1000;
    this.emitter.emit(etype, _.extend({
      userId: this.data.user_id,
      jobId: this.id,
      timeElapsed: elapsed,
      repoUrl: this.data.repo_config.url,
      stdout: '',
      stderr: '',
      stdmerged: '',
      autoDetectResult: null,
      testExitCode: null,
      deployExitCode: null,
      tasks: null
    }, data));
  },
  complete: function (testCode, deployCode, tasks, next) {
    this.sendEvent('queue.job_complete', {
      stdout: this.std.out,
      stderr: this.std.err,
      stdmerged: this.std.merged,
      testExitCode: testCode,
      deployExitCode: deployCode,
      tasks: tasks
    });
    next && next();
  },
  // for backwards compat. TODO: remove.
  forkProc: function (cwd, command, args, next) {
    var env = _.extend({}, process.env);
    var screencmd = null;

    // generate domain name for this repo and branch
    var message = this.data.github_commit_info && this.data.github_commit_info.message || 'manual start';
    var branch = this.data.github_commit_info && this.data.github_commit_info.branch || 'master';
    var domain = utils.domainForGithubRepoBranch(this.data.repo_ssh_url, branch);

    // export strider-specific variables
    env.PAAS_NAME = 'strider';
    env.STRIDER_JOB_ID = this.data.job_id;
    env.STRIDER_REPO_DOMAIN = domain;

    // parse hints from commit message, export if any are defined
    var hint = hints.parse(message);
    if (hint) {
      env.STRIDER_HINT = hints.parse(message);
    }

    // project variables may override ones above
    if (this.data.repo_config.env !== undefined) {
      env = _.extend(env, this.data.repo_config.env);
    }
    // change to arguments.length === 2 ?
    if (typeof(cwd) === 'object') {
      next = command;
      command = cwd.cmd;
      args = cwd.args;
      env = _.extend(env, cwd.env);
      screencmd = cwd.screencmd || null;
      cwd = cwd.cwd;
    }
    if (typeof(command) === 'string' && typeof(args) === 'function') {
      next = args;
      args = null;
      if (!this.config.pty) {
        args = command.split(/\s+/);
        command = args.shift();
      }
    }
    if (!this.config.pty && !args) {
      args = [];
    }
    return cmd.run({
      io: this.io,
      screencmd: screencmd,
      command: command,
      pty: this.config.pty,
      args: args,
      cwd: cwd,
      env: env
    }, next);
  },
  gitStep: function (done, cb) {
    var self = this;
    var urls = utils.getUrls(self.data.repo_ssh_url,
      self.data.repo_config.privkey, self.data.github_apikey);
    var branch = self.data.github_commit_info && self.data.github_commit_info.branch || "master";

    function gitdone(code, sout, serr) {
      var msg, errat;
      if (code) {
        msg = 'Git failure';
        errat = (serr || sout).indexOf('fatal: could not read Username');
        if (errat !== -1 && errat < 20) {
          msg = 'Failed to authenticate. Do you still have access to this repo?';
        }
        self.io.emit('stderr', msg + ' (exit code: ' + code + ')', 'error');
        return self.complete(code, null, null, done);
      }
      return cb(null, self.context);
    }

    // clone fresh
    if (!fs.existsSync(self.dir + '/.git') || !self.config.gitUpdate) {
      return cmd.run({
        io: self.io,
        // cwd: self.dir,
        command: 'rm -rf ' + self.dir + '; mkdir -p ' + self.dir,
        screencmd: false,
        pty: false
      }, function (code) {
        if (code) {
          self.io.emit('error', new Error('Failed to clean out old code'));
          return self.complete(code, null, null, done);
        }
        self.io.emit('stdout', 'Starting git clone of repo at ' + urls[1], 'message');
        var command = ( branch == 'master' ?
          'git clone --recursive ' + urls[0] + ' .; git checkout ' + branch :
          'git clone --recursive ' + urls[0] + ' .; git checkout ' + branch );
        cmd.git({
          io: self.io,
          cwd: self.dir,
          privKey: self.data.repo_config.privkey,
          command: command,
          screencmd: command.replace(urls[0], urls[1])
        }, gitdone);
      });
    }
    // or update
    Step(
      function () {
        cmd.run({
          io: self.io,
          cwd: self.dir,
          command: 'git reset --hard; git clean -fd;',
          pty: self.config.pty // should we just never to pty here?
        }, this);
      },
      function (code) {
        if (code) {
          self.io.emit('stderr', 'Failed to git reset', 'error');
          return self.complete(code, null, null, done);
        }
        cmd.run({
          io: self.io,
          cwd: self.dir,
          command: 'git fetch origin; git checkout -B ' + branch + ' origin/' + branch + ';',
          pty: self.config.pty // should we just never to pty here?
        }, this);
      },
      function (code) {
        if (code) {
          self.io.emit('stderr', 'Failed to checkout master', 'error');
          return self.complete(code, null, null, done);
        }
        cmd.git({
          io: self.io,
          cwd: self.dir,
          privKey: self.data.repo_config.privkey,
          command: 'git pull'
        }, gitdone);
      }
    );
  }
};
