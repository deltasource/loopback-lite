// Copyright IBM Corp. 2013,2019. All Rights Reserved.
// Node module: loopback
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

'use strict';
const assert = require('assert');
const expect = require('./helpers/expect');
const request = require('supertest');
const loopback = require('../');
const async = require('async');
const url = require('url');
const extend = require('util')._extend;
const Promise = require('bluebird');
const waitForEvent = require('./helpers/wait-for-event');

let User, AccessToken;

describe('User', function() {
  this.timeout(10000);

  const validCredentialsEmail = 'foo@bar.com';
  const validCredentials = {email: validCredentialsEmail, password: 'bar'};
  const validCredentialsEmailVerified = {
    email: 'foo1@bar.com', password: 'bar1', emailVerified: true};
  const validCredentialsEmailVerifiedOverREST = {
    email: 'foo2@bar.com', password: 'bar2', emailVerified: true};
  const validCredentialsWithRealm = {
    email: 'foo3@bar.com', password: 'bar', realm: 'foobar'};
  const validCredentialsWithTTL = {email: 'foo@bar.com', password: 'bar', ttl: 3600};
  const validCredentialsWithTTLAndScope = {
    email: 'foo@bar.com', password: 'bar', ttl: 3600, scope: 'all'};
  const validMixedCaseEmailCredentials = {email: 'Foo@bar.com', password: 'bar'};
  const invalidCredentials = {email: 'foo1@bar.com', password: 'invalid'};
  const incompleteCredentials = {password: 'bar1'};
  let validCredentialsUser, validCredentialsEmailVerifiedUser, user;

  // Create a local app variable to prevent clashes with the global
  // variable shared by all tests. While this should not be necessary if
  // the tests were written correctly, it turns out that's not the case :(
  let app = null;

  beforeEach(function setupAppAndModels() {
    // override the global app object provided by test/support.js
    // and create a local one that does not share state with other tests
    app = loopback({localRegistry: true, loadBuiltinModels: true});
    app.set('remoting', {errorHandler: {debug: true, log: false}});
    app.dataSource('db', {connector: 'memory'});

    // attach User and related models
    User = app.registry.createModel({
      name: 'TestUser',
      base: 'User',
      properties: {
        // Use a custom id property to verify that User methods
        // are correctly looking up the primary key
        pk: {type: 'String', defaultFn: 'guid', id: true},
      },
      http: {path: 'test-users'},
      // forceId is set to false for the purpose of updating the same affected user within the
      // `Email Update` test cases.
      forceId: false,
      // Speed up the password hashing algorithm for tests
      saltWorkFactor: 4,
    });
    app.model(User, {dataSource: 'db'});

    AccessToken = app.registry.getModel('AccessToken');
    app.model(AccessToken, {dataSource: 'db'});

    // Update the AccessToken relation to use the subclass of User
    AccessToken.belongsTo(User, {as: 'user', foreignKey: 'userId'});
    User.hasMany(AccessToken, {as: 'accessTokens', foreignKey: 'userId'});

    // Speed up the password hashing algorithm
    // for tests using the built-in User model
    User.settings.saltWorkFactor = 4;

    // allow many User.afterRemote's to be called
    User.setMaxListeners(0);

    app.enableAuth({dataSource: 'db'});
    app.use(loopback.token({model: AccessToken}));
    app.use(loopback.rest());

    // create 2 users: with and without verified email
    return Promise.map(
      [validCredentials, validCredentialsEmailVerified],
      credentials => User.create(credentials),
    ).then(users => {
      validCredentialsUser = user = users[0];
      validCredentialsEmailVerifiedUser = users[1];
    });
  });

  describe('User.create', function() {
    it('Create a new user', function(done) {
      User.create({email: 'f@b.com', password: 'bar'}, function(err, user) {
        assert(!err);
        assert(user.pk);
        assert(user.email);

        done();
      });
    });

    it('Create a new user (email case-sensitivity off)', function(done) {
      User.settings.caseSensitiveEmail = false;
      User.create({email: 'F@b.com', password: 'bar'}, function(err, user) {
        if (err) return done(err);

        assert(user.pk);
        assert.equal(user.email, user.email.toLowerCase());

        done();
      });
    });

    it('Create a new user (email case-sensitive)', function(done) {
      User.create({email: 'F@b.com', password: 'bar'}, function(err, user) {
        if (err) return done(err);

        assert(user.pk);
        assert(user.email);
        assert.notEqual(user.email, user.email.toLowerCase());

        done();
      });
    });

    it('fails when the required email is missing (case-sensitivity on)', () => {
      User.create({password: '123'})
        .then(
          success => { throw new Error('create should have failed'); },
          err => {
            expect(err.name).to.equal('ValidationError');
            expect(err.statusCode).to.equal(422);
            expect(err.details.context).to.equal(User.modelName);
            expect(err.details.codes.email).to.deep.equal(['presence']);
          },
        );
    });

    it('fails when the required email is missing (case-sensitivity off)', () => {
      User.settings.caseSensitiveEmail = false;
      User.create({email: undefined, password: '123'})
        .then(
          success => { throw new Error('create should have failed'); },
          err => {
            expect(err.name).to.equal('ValidationError');
            expect(err.statusCode).to.equal(422);
            expect(err.details.context).to.equal(User.modelName);
            expect(err.details.codes.email).to.deep.equal(['presence']);
          },
        );
    });

    // will change in future versions where password will be optional by default
    it('Password is required', function(done) {
      const u = new User({email: '123@456.com'});

      User.create({email: 'c@d.com'}, function(err) {
        assert(err);

        done();
      });
    });

    it('Requires a valid email', function(done) {
      User.create({email: 'foo@', password: '123'}, function(err) {
        assert(err);
        assert.equal(err.name, 'ValidationError');
        assert.equal(err.statusCode, 422);
        assert.equal(err.details.context, User.modelName);
        assert.deepEqual(err.details.codes.email, ['custom.email']);
        done();
      });
    });

    it('allows TLD domains in email', function() {
      return User.create({
        email: 'local@com',
        password: '123',
      });
    });

    it('Requires a unique email', function(done) {
      User.create({email: 'a@b.com', password: 'foobar'}, function() {
        User.create({email: 'a@b.com', password: 'batbaz'}, function(err) {
          assert(err, 'should error because the email is not unique!');

          done();
        });
      });
    });

    it('Requires a unique email (email case-sensitivity off)', function(done) {
      User.settings.caseSensitiveEmail = false;
      User.create({email: 'A@b.com', password: 'foobar'}, function(err) {
        if (err) return done(err);

        User.create({email: 'a@b.com', password: 'batbaz'}, function(err) {
          assert(err, 'should error because the email is not unique!');

          done();
        });
      });
    });

    it('Requires a unique email (email case-sensitive)', function(done) {
      User.create({email: 'A@b.com', password: 'foobar'}, function(err, user1) {
        User.create({email: 'a@b.com', password: 'batbaz'}, function(err, user2) {
          if (err) return done(err);

          assert.notEqual(user1.email, user2.email);

          done();
        });
      });
    });

    it('Requires a unique username', function(done) {
      User.create({email: 'a@b.com', username: 'abc', password: 'foobar'}, function() {
        User.create({email: 'b@b.com', username: 'abc', password: 'batbaz'}, function(err) {
          assert(err, 'should error because the username is not unique!');

          done();
        });
      });
    });

    it('Requires a password to login with basic auth', function(done) {
      User.create({email: 'b@c.com'}, function(err) {
        User.login({email: 'b@c.com'}, function(err, accessToken) {
          assert(!accessToken, 'should not create a accessToken without a valid password');
          assert(err, 'should not login without a password');
          assert.equal(err.code, 'LOGIN_FAILED');

          done();
        });
      });
    });

    it('Hashes the given password', function() {
      const u = new User({username: 'foo', password: 'bar'});
      assert(u.password !== 'bar');
    });

    it('does not hash the password if it\'s already hashed', function() {
      const u1 = new User({username: 'foo', password: 'bar'});
      assert(u1.password !== 'bar');
      const u2 = new User({username: 'foo', password: u1.password});
      assert(u2.password === u1.password);
    });

    it('invalidates the user\'s accessToken when the user is deleted By id', function(done) {
      let usersId;
      async.series([
        function(next) {
          User.create({email: 'b@c.com', password: 'bar'}, function(err, user) {
            usersId = user.pk;
            next(err);
          });
        },
        function(next) {
          User.login({email: 'b@c.com', password: 'bar'}, function(err, accessToken) {
            if (err) return next(err);
            assert(accessToken.userId);
            next();
          });
        },
        function(next) {
          User.deleteById(usersId, function(err) {
            next(err);
          });
        },
        function(next) {
          User.findById(usersId, function(err, userFound) {
            if (err) return next(err);
            expect(userFound).to.equal(null);
            AccessToken.find({where: {userId: usersId}}, function(err, tokens) {
              if (err) return next(err);
              expect(tokens.length).to.equal(0);
              next();
            });
          });
        },
      ], function(err) {
        if (err) return done(err);
        done();
      });
    });

    it('skips token invalidation when the relation is not configured', () => {
      const app = loopback({localRegistry: true, loadBuiltinModels: true});
      app.dataSource('db', {connector: 'memory'});

      const PrivateUser = app.registry.createModel({
        name: 'PrivateUser',
        base: 'User',
        // Speed up the password hashing algorithm for tests
        saltWorkFactor: 4,
      });
      app.model(PrivateUser, {dataSource: 'db'});

      return PrivateUser.create({email: 'private@example.com', password: 'pass'})
        .then(u => PrivateUser.deleteById(u.id));
      // the test passed when the operation did not crash
    });

    it('invalidates the user\'s accessToken when the user is deleted all', function(done) {
      let userIds = [];
      let users;
      async.series([
        function(next) {
          User.create([
            {name: 'myname', email: 'b@c.com', password: 'bar'},
            {name: 'myname', email: 'd@c.com', password: 'bar'},
          ], function(err, createdUsers) {
            users = createdUsers;
            userIds = createdUsers.map(function(u) {
              return u.pk;
            });
            next(err);
          });
        },
        function(next) {
          User.login({email: 'b@c.com', password: 'bar'}, function(err, accessToken) {
            if (err) return next(err);
            assertGoodToken(accessToken, users[0]);
            next();
          });
        },
        function(next) {
          User.login({email: 'd@c.com', password: 'bar'}, function(err, accessToken) {
            if (err) return next(err);
            assertGoodToken(accessToken, users[1]);
            next();
          });
        },
        function(next) {
          User.deleteAll({name: 'myname'}, function(err, user) {
            next(err);
          });
        },
        function(next) {
          User.find({where: {name: 'myname'}}, function(err, userFound) {
            if (err) return next(err);
            expect(userFound.length).to.equal(0);
            AccessToken.find({where: {userId: {inq: userIds}}}, function(err, tokens) {
              if (err) return next(err);
              expect(tokens.length).to.equal(0);
              next();
            });
          });
        },
      ], function(err) {
        if (err) return done(err);
        done();
      });
    });

    describe('custom password hash', function() {
      let defaultHashPassword, defaultValidatePassword;

      beforeEach(function() {
        defaultHashPassword = User.hashPassword;
        defaultValidatePassword = User.validatePassword;

        User.hashPassword = function(plain) {
          return plain.toUpperCase();
        };

        User.validatePassword = function(plain) {
          if (!plain || plain.length < 3) {
            throw new Error('Password must have at least 3 chars');
          }
          return true;
        };
      });

      afterEach(function() {
        User.hashPassword = defaultHashPassword;
        User.validatePassword = defaultValidatePassword;
      });

      it('Reports invalid password', function() {
        try {
          const u = new User({username: 'foo', password: 'aa'});
          assert(false, 'Error should have been thrown');
        } catch (e) {
          // Ignore
        }
      });

      it('Hashes the given password', function() {
        const u = new User({username: 'foo', password: 'bar'});
        assert(u.password === 'BAR');
      });
    });

    it('Create a user over REST should remove emailVerified property', function(done) {
      request(app)
        .post('/test-users')
        .expect('Content-Type', /json/)
        .expect(200)
        .send(validCredentialsEmailVerifiedOverREST)
        .end(function(err, res) {
          if (err) return done(err);

          assert(!res.body.emailVerified);

          done();
        });
    });
  });

  describe('Password length validation', function() {
    const pass72Char = new Array(70).join('a') + '012';
    const pass73Char = pass72Char + '3';
    const passTooLong = pass72Char + 'WXYZ1234';

    it('rejects empty passwords creation', function(done) {
      User.create({email: 'b@c.com', password: ''}, function(err) {
        expect(err.code).to.equal('INVALID_PASSWORD');
        expect(err.statusCode).to.equal(422);
        done();
      });
    });

    it('rejects updating with empty password', function(done) {
      User.create({email: 'blank@c.com', password: pass72Char}, function(err, userCreated) {
        if (err) return done(err);
        userCreated.updateAttribute('password', '', function(err, userUpdated) {
          expect(err.code).to.equal('INVALID_PASSWORD');
          expect(err.statusCode).to.equal(422);
          done();
        });
      });
    });

    it('rejects updating with empty password using replaceAttributes', function(done) {
      User.create({email: 'b@example.com', password: pass72Char}, function(err, userCreated) {
        if (err) return done(err);
        userCreated.replaceAttributes({'password': ''}, function(err, userUpdated) {
          expect(err.code).to.equal('INVALID_PASSWORD');
          expect(err.statusCode).to.equal(422);
          done();
        });
      });
    });

    it('rejects updating with empty password using updateOrCreate', function(done) {
      User.create({email: 'b@example.com', password: pass72Char}, function(err, userCreated) {
        if (err) return done(err);
        User.updateOrCreate({id: userCreated.id, 'password': ''}, function(err, userUpdated) {
          expect(err.code).to.equal('INVALID_PASSWORD');
          expect(err.statusCode).to.equal(422);
          done();
        });
      });
    });

    it('rejects updating with empty password using updateAll', function(done) {
      User.create({email: 'b@example.com', password: pass72Char}, function(err, userCreated) {
        if (err) return done(err);
        User.updateAll({where: {id: userCreated.id}}, {'password': ''}, function(err, userUpdated) {
          expect(err.code).to.equal('INVALID_PASSWORD');
          expect(err.statusCode).to.equal(422);
          done();
        });
      });
    });

    it('rejects passwords longer than 72 characters', function(done) {
      User.create({email: 'b@c.com', password: pass73Char}, function(err) {
        expect(err.code).to.equal('PASSWORD_TOO_LONG');
        expect(err.statusCode).to.equal(422);
        done();
      });
    });

    it('rejects a new user with password longer than 72 characters', function(done) {
      try {
        const u = new User({username: 'foo', password: pass73Char});
        assert(false, 'Error should have been thrown');
      } catch (e) {
        expect(e).to.match(/password entered was too long/);
        done();
      }
    });

    it('accepts passwords that are exactly 72 characters long', function(done) {
      User.create({email: 'b@c.com', password: pass72Char}, function(err, user) {
        if (err) return done(err);
        User.findById(user.pk, function(err, userFound) {
          if (err) return done(err);
          assert(userFound);
          done();
        });
      });
    });

    it('allows login with password exactly 72 characters long', function(done) {
      User.create({email: 'b@c.com', password: pass72Char}, function(err, user) {
        if (err) return done(err);
        User.login({email: 'b@c.com', password: pass72Char}, function(err, accessToken) {
          if (err) return done(err);
          assertGoodToken(accessToken, user);
          done();
        });
      });
    });

    it('rejects password reset when password is more than 72 chars', function(done) {
      User.create({email: 'b@c.com', password: pass72Char}, function(err) {
        if (err) return done(err);
        User.resetPassword({email: 'b@c.com', password: pass73Char}, function(err) {
          assert(err);
          expect(err).to.match(/password entered was too long/);
          done();
        });
      });
    });

    it('rejects changePassword when new password is longer than 72 chars', function() {
      return User.create({email: 'test@example.com', password: pass72Char})
        .then(u => u.changePassword(pass72Char, pass73Char))
        .then(
          success => { throw new Error('changePassword should have failed'); },
          err => {
            expect(err.message).to.match(/password entered was too long/);

            // workaround for chai problem
            //   object tested must be an array, an object, or a string,
            //   but error given
            const props = Object.assign({}, err);
            expect(props).to.contain({
              code: 'PASSWORD_TOO_LONG',
              statusCode: 422,
            });
          },
        );
    });

    it('rejects setPassword when new password is longer than 72 chars', function() {
      return User.create({email: 'test@example.com', password: pass72Char})
        .then(u => u.setPassword(pass73Char))
        .then(
          success => { throw new Error('setPassword should have failed'); },
          err => {
            expect(err.message).to.match(/password entered was too long/);

            // workaround for chai problem
            //   object tested must be an array, an object, or a string,
            //   but error given
            const props = Object.assign({}, err);
            expect(props).to.contain({
              code: 'PASSWORD_TOO_LONG',
              statusCode: 422,
            });
          },
        );
    });
  });

  describe('Access-hook for queries with email NOT case-sensitive', function() {
    it('Should not throw an error if the query does not contain {where: }', function(done) {
      User.find({}, function(err) {
        if (err) done(err);

        done();
      });
    });

    it('Should be able to find lowercase email with mixed-case email query', function(done) {
      User.settings.caseSensitiveEmail = false;
      User.find({where: {email: validMixedCaseEmailCredentials.email}}, function(err, result) {
        if (err) done(err);

        assert(result[0], 'The query did not find the user');
        assert.equal(result[0].email, validCredentialsEmail);

        done();
      });
    });

    it('Should be able to use query filters (email case-sensitivity off)', function(done) {
      User.settings.caseSensitiveEmail = false;
      const insensitiveUser = {email: 'insensitive@example.com', password: 'abc'};
      User.create(insensitiveUser, function(err, user) {
        User.find({where: {email:
          {inq: [insensitiveUser.email]},
        }}, function(err, result) {
          if (err) done(err);
          assert(result[0], 'The query did not find the user');
          assert.equal(result[0].email, insensitiveUser.email);
          done();
        });
      });
    });

    it('Should be able to use query filters (email case-sensitivity on)', function(done) {
      User.settings.caseSensitiveEmail = true;
      const sensitiveUser = {email: 'senSiTive@example.com', password: 'abc'};
      User.create(sensitiveUser, function(err, user) {
        User.find({where: {email:
          {inq: [sensitiveUser.email]},
        }}, function(err, result) {
          if (err) done(err);
          assert(result[0], 'The query did not find the user');
          assert.equal(result[0].email, sensitiveUser.email);
          done();
        });
      });
    });
  });

  describe('User.login', function() {
    it('Login a user by providing credentials', function(done) {
      User.login(validCredentials, function(err, accessToken) {
        assertGoodToken(accessToken, validCredentialsUser);

        done();
      });
    });

    it('Login a user by providing email credentials (email case-sensitivity off)', function(done) {
      User.settings.caseSensitiveEmail = false;
      User.login(validMixedCaseEmailCredentials, function(err, accessToken) {
        assertGoodToken(accessToken, validCredentialsUser);

        done();
      });
    });

    it('Try to login with invalid email case', function(done) {
      User.login(validMixedCaseEmailCredentials, function(err, accessToken) {
        assert(err);

        done();
      });
    });

    it('should not allow queries in email field', function(done) {
      User.login({email: {'neq': 'x'}, password: 'x'}, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'INVALID_EMAIL');
        assert(!accessToken);

        done();
      });
    });

    it('should not allow queries in username field', function(done) {
      User.login({username: {'neq': 'x'}, password: 'x'}, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'INVALID_USERNAME');
        assert(!accessToken);

        done();
      });
    });

    it('should not allow queries in realm field', function(done) {
      User.settings.realmRequired = true;
      User.login({username: 'x', password: 'x', realm: {'neq': 'x'}}, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'INVALID_REALM');
        assert(!accessToken);

        done();
      });
    });

    it('Login a user by providing credentials with TTL', function(done) {
      User.login(validCredentialsWithTTL, function(err, accessToken) {
        assertGoodToken(accessToken, validCredentialsUser);
        assert.equal(accessToken.ttl, validCredentialsWithTTL.ttl);

        done();
      });
    });

    it('honors default `createAccessToken` implementation', function(done) {
      User.login(validCredentialsWithTTL, function(err, accessToken) {
        assert(accessToken.userId);
        assert(accessToken.id);

        User.findById(accessToken.userId, function(err, user) {
          user.createAccessToken(120, function(err, accessToken) {
            assertGoodToken(accessToken, validCredentialsUser);
            assert.equal(accessToken.ttl, 120);

            done();
          });
        });
      });
    });

    it('honors default `createAccessToken` implementation - promise variant', function(done) {
      User.login(validCredentialsWithTTL, function(err, accessToken) {
        assert(accessToken.userId);
        assert(accessToken.id);

        User.findById(accessToken.userId, function(err, user) {
          user.createAccessToken(120)
            .then(function(accessToken) {
              assertGoodToken(accessToken, validCredentialsUser);
              assert.equal(accessToken.ttl, 120);

              done();
            })
            .catch(function(err) {
              done(err);
            });
        });
      });
    });

    it('Login a user using a custom createAccessToken', function(done) {
      const createToken = User.prototype.createAccessToken; // Save the original method
      // Override createAccessToken
      User.prototype.createAccessToken = function(ttl, cb) {
        // Reduce the ttl by half for testing purpose
        this.accessTokens.create({ttl: ttl / 2}, cb);
      };
      User.login(validCredentialsWithTTL, function(err, accessToken) {
        assertGoodToken(accessToken, validCredentialsUser);
        assert.equal(accessToken.ttl, 1800);

        User.findById(accessToken.userId, function(err, user) {
          user.createAccessToken(120, function(err, accessToken) {
            assertGoodToken(accessToken, validCredentialsUser);
            assert.equal(accessToken.ttl, 60);
            // Restore create access token
            User.prototype.createAccessToken = createToken;

            done();
          });
        });
      });
    });

    it('Login a user using a custom createAccessToken with options',
      function(done) {
        const createToken = User.prototype.createAccessToken; // Save the original method
        // Override createAccessToken
        User.prototype.createAccessToken = function(ttl, options, cb) {
          // Reduce the ttl by half for testing purpose
          this.accessTokens.create({ttl: ttl / 2, scopes: [options.scope]}, cb);
        };
        User.login(validCredentialsWithTTLAndScope, function(err, accessToken) {
          assertGoodToken(accessToken, validCredentialsUser);
          assert.equal(accessToken.ttl, 1800);
          assert.deepEqual(accessToken.scopes, ['all']);

          User.findById(accessToken.userId, function(err, user) {
            user.createAccessToken(120, {scope: 'default'}, function(err, accessToken) {
              assertGoodToken(accessToken, validCredentialsUser);
              assert.equal(accessToken.ttl, 60);
              assert.deepEqual(accessToken.scopes, ['default']);
              // Restore create access token
              User.prototype.createAccessToken = createToken;

              done();
            });
          });
        });
      });

    it('Login should only allow correct credentials', function(done) {
      User.login(invalidCredentials, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'LOGIN_FAILED');
        assert(!accessToken);

        done();
      });
    });

    it('Login should only allow correct credentials - promise variant', function(done) {
      User.login(invalidCredentials)
        .then(function(accessToken) {
          expect(accessToken, 'accessToken').to.not.exist();

          done();
        })
        .catch(function(err) {
          expect(err, 'err').to.exist();
          expect(err).to.have.property('code', 'LOGIN_FAILED');

          done();
        });
    });

    it('Login a user providing incomplete credentials', function(done) {
      User.login(incompleteCredentials, function(err, accessToken) {
        expect(err, 'err').to.exist();
        expect(err).to.have.property('code', 'USERNAME_EMAIL_REQUIRED');

        done();
      });
    });

    it('Login a user providing incomplete credentials - promise variant', function(done) {
      User.login(incompleteCredentials)
        .then(function(accessToken) {
          expect(accessToken, 'accessToken').to.not.exist();

          done();
        })
        .catch(function(err) {
          expect(err, 'err').to.exist();
          expect(err).to.have.property('code', 'USERNAME_EMAIL_REQUIRED');

          done();
        });
    });

    it('Login a user over REST by providing credentials', function(done) {
      request(app)
        .post('/test-users/login')
        .expect('Content-Type', /json/)
        .expect(200)
        .send(validCredentials)
        .end(function(err, res) {
          if (err) return done(err);

          const accessToken = res.body;

          assertGoodToken(accessToken, validCredentialsUser);
          assert(accessToken.user === undefined);

          done();
        });
    });

    it('Login a user over REST by providing invalid credentials', function(done) {
      request(app)
        .post('/test-users/login')
        .expect('Content-Type', /json/)
        .expect(401)
        .send(invalidCredentials)
        .end(function(err, res) {
          if (err) return done(err);

          const errorResponse = res.body.error;
          assert.equal(errorResponse.code, 'LOGIN_FAILED');

          done();
        });
    });

    it('Login a user over REST by providing incomplete credentials', function(done) {
      request(app)
        .post('/test-users/login')
        .expect('Content-Type', /json/)
        .expect(400)
        .send(incompleteCredentials)
        .end(function(err, res) {
          if (err) return done(err);

          const errorResponse = res.body.error;
          assert.equal(errorResponse.code, 'USERNAME_EMAIL_REQUIRED');

          done();
        });
    });

    it('Login a user over REST with the wrong Content-Type', function(done) {
      request(app)
        .post('/test-users/login')
        .set('Content-Type', null)
        .expect('Content-Type', /json/)
        .expect(400)
        .send(JSON.stringify(validCredentials))
        .end(function(err, res) {
          if (err) return done(err);

          const errorResponse = res.body.error;
          assert.equal(errorResponse.code, 'USERNAME_EMAIL_REQUIRED');

          done();
        });
    });

    it('Returns current user when `include` is `USER`', function(done) {
      request(app)
        .post('/test-users/login?include=USER')
        .send(validCredentials)
        .expect(200)
        .expect('Content-Type', /json/)
        .end(function(err, res) {
          if (err) return done(err);

          const token = res.body;
          expect(token.user, 'body.user').to.not.equal(undefined);
          expect(token.user, 'body.user')
            .to.have.property('email', validCredentials.email);

          done();
        });
    });

    it('should handle multiple `include`', function(done) {
      request(app)
        .post('/test-users/login?include=USER&include=Post')
        .send(validCredentials)
        .expect(200)
        .expect('Content-Type', /json/)
        .end(function(err, res) {
          if (err) return done(err);

          const token = res.body;
          expect(token.user, 'body.user').to.not.equal(undefined);
          expect(token.user, 'body.user')
            .to.have.property('email', validCredentials.email);

          done();
        });
    });

    it('allows login with password too long but created in old LB version',
      function(done) {
        const bcrypt = require('bcryptjs');
        const longPassword = new Array(80).join('a');
        const oldHash = bcrypt.hashSync(longPassword, bcrypt.genSaltSync(1));

        User.create({email: 'b@c.com', password: oldHash}, function(err) {
          if (err) return done(err);
          User.login({email: 'b@c.com', password: longPassword}, function(err, accessToken) {
            if (err) return done(err);
            assert(accessToken.id);
            // we are logged in, the test passed
            done();
          });
        });
      });
  });

  function assertGoodToken(accessToken, user) {
    if (accessToken instanceof AccessToken) {
      accessToken = accessToken.toJSON();
    }
    expect(accessToken).to.have.property('userId', user.pk);
    assert(accessToken.id);
    assert.equal(accessToken.id.length, 64);
  }

  describe('User.login requiring realm', function() {
    let User, AccessToken;

    beforeEach(function() {
      User = app.registry.createModel('RealmUser', {}, {
        base: 'TestUser',
        realmRequired: true,
        realmDelimiter: ':',
      });

      AccessToken = app.registry.createModel('RealmAccessToken', {}, {
        base: 'AccessToken',
      });

      app.model(AccessToken, {dataSource: 'db'});
      app.model(User, {dataSource: 'db'});

      // Update the AccessToken relation to use the subclass of User
      AccessToken.belongsTo(User, {as: 'user', foreignKey: 'userId'});
      User.hasMany(AccessToken, {as: 'accessTokens', foreignKey: 'userId'});

      // allow many User.afterRemote's to be called
      User.setMaxListeners(0);
    });

    const realm1User = {
      realm: 'realm1',
      username: 'foo100',
      email: 'foo100@bar.com',
      password: 'pass100',
    };

    const realm2User = {
      realm: 'realm2',
      username: 'foo100',
      email: 'foo100@bar.com',
      password: 'pass200',
    };

    const credentialWithoutRealm = {
      username: 'foo100',
      email: 'foo100@bar.com',
      password: 'pass100',
    };

    const credentialWithBadPass = {
      realm: 'realm1',
      username: 'foo100',
      email: 'foo100@bar.com',
      password: 'pass001',
    };

    const credentialWithBadRealm = {
      realm: 'realm3',
      username: 'foo100',
      email: 'foo100@bar.com',
      password: 'pass100',
    };

    const credentialWithRealm = {
      realm: 'realm1',
      username: 'foo100',
      password: 'pass100',
    };

    const credentialRealmInUsername = {
      username: 'realm1:foo100',
      password: 'pass100',
    };

    const credentialRealmInEmail = {
      email: 'realm1:foo100@bar.com',
      password: 'pass100',
    };

    let user1 = null;
    beforeEach(function(done) {
      User.create(realm1User, function(err, u) {
        if (err) return done(err);

        user1 = u;
        User.create(realm2User, done);
      });
    });

    it('honors unique email for realm', function(done) {
      User.create(realm1User, function(err, u) {
        assert(err);
        assert(err.message.match(/User already exists/) &&
          err.message.match(/Email already exists/));
        done();
      });
    });

    it('rejects a user by without realm', function(done) {
      User.login(credentialWithoutRealm, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'REALM_REQUIRED');

        done();
      });
    });

    it('rejects a user by with bad realm', function(done) {
      User.login(credentialWithBadRealm, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'LOGIN_FAILED');

        done();
      });
    });

    it('rejects a user by with bad pass', function(done) {
      User.login(credentialWithBadPass, function(err, accessToken) {
        assert(err);
        assert.equal(err.code, 'LOGIN_FAILED');

        done();
      });
    });

    it('logs in a user by with realm', function(done) {
      User.login(credentialWithRealm, function(err, accessToken) {
        assertGoodToken(accessToken, user1);

        done();
      });
    });

    it('logs in a user by with realm in username', function(done) {
      User.login(credentialRealmInUsername, function(err, accessToken) {
        assertGoodToken(accessToken, user1);

        done();
      });
    });

    it('logs in a user by with realm in email', function(done) {
      User.login(credentialRealmInEmail, function(err, accessToken) {
        assertGoodToken(accessToken, user1);

        done();
      });
    });

    describe('User.login with realmRequired but no realmDelimiter', function() {
      beforeEach(function() {
        User.settings.realmDelimiter = undefined;
      });

      afterEach(function() {
        User.settings.realmDelimiter = ':';
      });

      it('logs in a user by with realm', function(done) {
        User.login(credentialWithRealm, function(err, accessToken) {
          assertGoodToken(accessToken, user1);

          done();
        });
      });

      it('rejects a user by with realm in email if realmDelimiter is not set',
        function(done) {
          User.login(credentialRealmInEmail, function(err, accessToken) {
            assert(err);
            assert.equal(err.code, 'REALM_REQUIRED');

            done();
          });
        });
    });
  });

  describe('User.logout', function() {
    it('Logout a user by providing the current accessToken id (using node)', function(done) {
      login(logout);

      function login(fn) {
        User.login(validCredentials, fn);
      }

      function logout(err, accessToken) {
        User.logout(accessToken.id, verify(accessToken.id, done));
      }
    });

    it('Logout a user by providing the current accessToken id (using node) - promise variant',
      function(done) {
        login(logout);

        function login(fn) {
          User.login(validCredentials, fn);
        }

        function logout(err, accessToken) {
          User.logout(accessToken.id)
            .then(function() {
              verify(accessToken.id, done);
            })
            .catch(done(err));
        }
      });

    it('Logout a user by providing the current accessToken id (over rest)', function(done) {
      login(logout);
      function login(fn) {
        request(app)
          .post('/test-users/login')
          .expect('Content-Type', /json/)
          .expect(200)
          .send(validCredentials)
          .end(function(err, res) {
            if (err) return done(err);

            const accessToken = res.body;
            assertGoodToken(accessToken, validCredentialsUser);

            fn(null, accessToken.id);
          });
      }

      function logout(err, token) {
        request(app)
          .post('/test-users/logout')
          .set('Authorization', token)
          .expect(204)
          .end(verify(token, done));
      }
    });

    it('fails when accessToken is not provided', function(done) {
      User.logout(undefined, function(err) {
        expect(err).to.have.property('message');
        expect(err).to.have.property('statusCode', 401);
        done();
      });
    });

    it('fails when accessToken is not found', function(done) {
      User.logout('expired-access-token', function(err) {
        expect(err).to.have.property('message');
        expect(err).to.have.property('statusCode', 401);
        done();
      });
    });

    function verify(token, done) {
      assert(token);

      return function(err) {
        if (err) return done(err);

        AccessToken.findById(token, function(err, accessToken) {
          assert(!accessToken, 'accessToken should not exist after logging out');

          done(err);
        });
      };
    }
  });

  describe('user.hasPassword(plain, fn)', function() {
    it('Determine if the password matches the stored password', function(done) {
      const u = new User({username: 'foo', password: 'bar'});
      u.hasPassword('bar', function(err, isMatch) {
        assert(isMatch, 'password doesnt match');

        done();
      });
    });

    it('Determine if the password matches the stored password - promise variant', function(done) {
      const u = new User({username: 'foo', password: 'bar'});
      u.hasPassword('bar')
        .then(function(isMatch) {
          assert(isMatch, 'password doesnt match');

          done();
        })
        .catch(function(err) {
          done(err);
        });
    });

    it('should match a password when saved', function(done) {
      const u = new User({username: 'a', password: 'b', email: 'z@z.net'});

      u.save(function(err, user) {
        User.findById(user.pk, function(err, uu) {
          uu.hasPassword('b', function(err, isMatch) {
            assert(isMatch);

            done();
          });
        });
      });
    });

    it('should match a password after it is changed', function(done) {
      User.create({email: 'foo@baz.net', username: 'bat', password: 'baz'}, function(err, user) {
        User.findById(user.pk, function(err, foundUser) {
          assert(foundUser);
          foundUser.hasPassword('baz', function(err, isMatch) {
            assert(isMatch);
            foundUser.password = 'baz2';
            foundUser.save(function(err, updatedUser) {
              updatedUser.hasPassword('baz2', function(err, isMatch) {
                assert(isMatch);
                User.findById(user.pk, function(err, uu) {
                  uu.hasPassword('baz2', function(err, isMatch) {
                    assert(isMatch);

                    done();
                  });
                });
              });
            });
          });
        });
      });
    });
  });

  describe('User.changePassword()', () => {
    let userId, currentPassword;
    beforeEach(givenUserIdAndPassword);

    it('changes the password - callback-style', done => {
      User.changePassword(userId, currentPassword, 'new password', (err) => {
        if (err) return done(err);
        expect(arguments.length, 'changePassword callback arguments length')
          .to.be.at.most(1);

        User.findById(userId, (err, user) => {
          if (err) return done(err);
          user.hasPassword('new password', (err, isMatch) => {
            if (err) return done(err);
            expect(isMatch, 'user has new password').to.be.true();
            done();
          });
        });
      });
    });

    it('changes the password - Promise-style', () => {
      return User.changePassword(userId, currentPassword, 'new password')
        .then(() => {
          expect(arguments.length, 'changePassword promise resolution')
            .to.equal(0);
          return User.findById(userId);
        })
        .then(user => {
          return user.hasPassword('new password');
        })
        .then(isMatch => {
          expect(isMatch, 'user has new password').to.be.true();
        });
    });

    it('changes the password - instance method', () => {
      return validCredentialsUser.changePassword(currentPassword, 'new password')
        .then(() => {
          expect(arguments.length, 'changePassword promise resolution')
            .to.equal(0);
          return User.findById(userId);
        })
        .then(user => {
          return user.hasPassword('new password');
        })
        .then(isMatch => {
          expect(isMatch, 'user has new password').to.be.true();
        });
    });

    it('fails when current password does not match', () => {
      return User.changePassword(userId, 'bad password', 'new password').then(
        success => { throw new Error('changePassword should have failed'); },
        err => {
          // workaround for chai problem
          //   object tested must be an array, an object,
          //   or a string, but error given
          const props = Object.assign({}, err);
          expect(props).to.contain({
            code: 'INVALID_PASSWORD',
            statusCode: 400,
          });
        },
      );
    });

    it('fails with 401 for unknown user id', () => {
      return User.changePassword('unknown-id', 'pass', 'pass').then(
        success => { throw new Error('changePassword should have failed'); },
        err => {
          // workaround for chai problem
          //   object tested must be an array, an object, or a string,
          //   but error given
          const props = Object.assign({}, err);
          expect(props).to.contain({
            code: 'USER_NOT_FOUND',
            statusCode: 401,
          });
        },
      );
    });

    it('forwards the "options" argument', () => {
      const options = {testFlag: true};
      const observedOptions = [];

      saveObservedOptionsForHook('access');
      saveObservedOptionsForHook('before save');

      return User.changePassword(userId, currentPassword, 'new', options)
        .then(() => expect(observedOptions).to.eql([
          // findById
          {hook: 'access', testFlag: true},

          // "before save" hook prepareForTokenInvalidation
          {hook: 'access', setPassword: true, testFlag: true},

          // updateAttributes
          {hook: 'before save', setPassword: true, testFlag: true},

          // validate uniqueness of User.email
          {hook: 'access', setPassword: true, testFlag: true},
        ]));

      function saveObservedOptionsForHook(name) {
        User.observe(name, (ctx, next) => {
          observedOptions.push(Object.assign({hook: name}, ctx.options));
          next();
        });
      }
    });

    function givenUserIdAndPassword() {
      userId = validCredentialsUser.id;
      currentPassword = validCredentials.password;
    }
  });

  describe('User.setPassword()', () => {
    let userId;
    beforeEach(givenUserId);

    it('changes the password - callback-style', done => {
      User.setPassword(userId, 'new password', (err) => {
        if (err) return done(err);
        expect(arguments.length, 'changePassword callback arguments length')
          .to.be.at.most(1);

        User.findById(userId, (err, user) => {
          if (err) return done(err);
          user.hasPassword('new password', (err, isMatch) => {
            if (err) return done(err);
            expect(isMatch, 'user has new password').to.be.true();
            done();
          });
        });
      });
    });

    it('changes the password - Promise-style', () => {
      return User.setPassword(userId, 'new password')
        .then(() => {
          expect(arguments.length, 'changePassword promise resolution')
            .to.equal(0);
          return User.findById(userId);
        })
        .then(user => {
          return user.hasPassword('new password');
        })
        .then(isMatch => {
          expect(isMatch, 'user has new password').to.be.true();
        });
    });

    it('fails with 401 for unknown users', () => {
      return User.setPassword('unknown-id', 'pass').then(
        success => { throw new Error('setPassword should have failed'); },
        err => {
          // workaround for chai problem
          //   object tested must be an array, an object, or a string,
          //   but error given
          const props = Object.assign({}, err);
          expect(props).to.contain({
            code: 'USER_NOT_FOUND',
            statusCode: 401,
          });
        },
      );
    });

    it('forwards the "options" argument', () => {
      const options = {testFlag: true};
      const observedOptions = [];

      saveObservedOptionsForHook('access');
      saveObservedOptionsForHook('before save');

      return User.setPassword(userId, 'new', options)
        .then(() => expect(observedOptions).to.eql([
          // findById
          {hook: 'access', testFlag: true},

          // "before save" hook prepareForTokenInvalidation
          {hook: 'access', setPassword: true, testFlag: true},

          // updateAttributes
          {hook: 'before save', setPassword: true, testFlag: true},

          // validate uniqueness of User.email
          {hook: 'access', setPassword: true, testFlag: true},
        ]));

      function saveObservedOptionsForHook(name) {
        User.observe(name, (ctx, next) => {
          observedOptions.push(Object.assign({hook: name}, ctx.options));
          next();
        });
      }
    });

    function givenUserId() {
      userId = validCredentialsUser.id;
    }
  });

  describe('AccessToken (session) invalidation', function() {
    let user, originalUserToken1, originalUserToken2, newUserCreated;
    const currentEmailCredentials = {email: 'original@example.com', password: 'bar'};
    const updatedEmailCredentials = {email: 'updated@example.com', password: 'bar'};
    const newUserCred = {email: 'newuser@example.com', password: 'newpass'};

    beforeEach('create user then login', function createAndLogin(done) {
      async.series([
        function createUserWithOriginalEmail(next) {
          User.create(currentEmailCredentials, function(err, userCreated) {
            if (err) return next(err);
            user = userCreated;
            next();
          });
        },
        function firstLoginWithOriginalEmail(next) {
          User.login(currentEmailCredentials, function(err, accessToken1) {
            if (err) return next(err);
            assert(accessToken1.userId);
            originalUserToken1 = accessToken1;
            next();
          });
        },
        function secondLoginWithOriginalEmail(next) {
          User.login(currentEmailCredentials, function(err, accessToken2) {
            if (err) return next(err);
            assert(accessToken2.userId);
            originalUserToken2 = accessToken2;
            next();
          });
        },
      ], done);
    });

    it('invalidates sessions when email is changed using `updateAttributes`', function(done) {
      user.updateAttributes(
        {email: updatedEmailCredentials.email},
        function(err, userInstance) {
          if (err) return done(err);
          assertNoAccessTokens(done);
        },
      );
    });

    it('invalidates sessions after `replaceAttributes`', function(done) {
      // The way how the invalidation is implemented now, all sessions
      // are invalidated on a full replace
      user.replaceAttributes(currentEmailCredentials, function(err, userInstance) {
        if (err) return done(err);
        assertNoAccessTokens(done);
      });
    });

    it('invalidates sessions when email is changed using `updateOrCreate`', function(done) {
      User.updateOrCreate({
        pk: user.pk,
        email: updatedEmailCredentials.email,
      }, function(err, userInstance) {
        if (err) return done(err);
        assertNoAccessTokens(done);
      });
    });

    it('invalidates sessions after `replaceById`', function(done) {
      // The way how the invalidation is implemented now, all sessions
      // are invalidated on a full replace
      User.replaceById(user.pk, currentEmailCredentials, function(err, userInstance) {
        if (err) return done(err);
        assertNoAccessTokens(done);
      });
    });

    it('invalidates sessions after `replaceOrCreate`', function(done) {
      // The way how the invalidation is implemented now, all sessions
      // are invalidated on a full replace
      User.replaceOrCreate({
        pk: user.pk,
        email: currentEmailCredentials.email,
        password: currentEmailCredentials.password,
      }, function(err, userInstance) {
        if (err) return done(err);
        assertNoAccessTokens(done);
      });
    });

    it('keeps sessions AS IS if firstName is added using `updateAttributes`', function(done) {
      user.updateAttributes({'firstName': 'Janny'}, function(err, userInstance) {
        if (err) return done(err);
        assertPreservedTokens(done);
      });
    });

    it('keeps sessions AS IS when calling save() with no changes', function(done) {
      user.save(function(err) {
        if (err) return done(err);
        assertPreservedTokens(done);
      });
    });

    it('keeps sessions AS IS if firstName is added using `updateOrCreate`', function(done) {
      User.updateOrCreate({
        pk: user.pk,
        firstName: 'Loay',
        email: currentEmailCredentials.email,
      }, function(err, userInstance) {
        if (err) return done(err);
        assertPreservedTokens(done);
      });
    });

    it('keeps sessions AS IS if a new user is created using `create`', function(done) {
      async.series([
        function(next) {
          User.create(newUserCred, function(err, newUserInstance) {
            if (err) return done(err);
            newUserCreated = newUserInstance;
            next();
          });
        },
        function(next) {
          User.login(newUserCred, function(err, newAccessToken) {
            if (err) return done(err);
            assert(newAccessToken.id);
            assertPreservedTokens(next);
          });
        },
      ], done);
    });

    it('keeps sessions AS IS if a new user is created using `updateOrCreate`', function(done) {
      async.series([
        function(next) {
          User.create(newUserCred, function(err, newUserInstance2) {
            if (err) return done(err);
            newUserCreated = newUserInstance2;
            next();
          });
        },
        function(next) {
          User.login(newUserCred, function(err, newAccessToken2) {
            if (err) return done(err);
            assert(newAccessToken2.id);
            assertPreservedTokens(next);
          });
        },
      ], done);
    });

    it('keeps sessions AS IS if non-email property is changed using updateAll', function(done) {
      let userPartial;
      async.series([
        function createPartialUser(next) {
          User.create(
            {email: 'partial@example.com', password: 'pass1', age: 25},
            function(err, partialInstance) {
              if (err) return next(err);
              userPartial = partialInstance;
              next();
            },
          );
        },
        function loginPartiallUser(next) {
          User.login({email: 'partial@example.com', password: 'pass1'}, function(err, ats) {
            if (err) return next(err);
            next();
          });
        },
        function updatePartialUser(next) {
          User.updateAll(
            {pk: userPartial.pk},
            {age: userPartial.age + 1},
            function(err, info) {
              if (err) return next(err);
              next();
            },
          );
        },
        function verifyTokensOfPartialUser(next) {
          AccessToken.find({where: {userId: userPartial.pk}}, function(err, tokens1) {
            if (err) return next(err);
            expect(tokens1.length).to.equal(1);
            next();
          });
        },
      ], done);
    });

    it('keeps sessions sessions when preserveAccessTokens is passed in options', function(done) {
      user.updateAttributes(
        {email: 'invalidateAccessTokens@example.com'},
        {preserveAccessTokens: true},
        function(err, userInstance) {
          if (err) return done(err);
          assertPreservedTokens(done);
        },
      );
    });

    it('preserves other users\' sessions if their email is  untouched', function(done) {
      let user1, user2, user3;
      async.series([
        function(next) {
          User.create({email: 'user1@example.com', password: 'u1pass'}, function(err, u1) {
            if (err) return done(err);
            User.create({email: 'user2@example.com', password: 'u2pass'}, function(err, u2) {
              if (err) return done(err);
              User.create({email: 'user3@example.com', password: 'u3pass'}, function(err, u3) {
                if (err) return done(err);
                user1 = u1;
                user2 = u2;
                user3 = u3;
                next();
              });
            });
          });
        },
        function(next) {
          User.login(
            {email: 'user1@example.com', password: 'u1pass'},
            function(err, accessToken1) {
              if (err) return next(err);
              User.login(
                {email: 'user2@example.com', password: 'u2pass'},
                function(err, accessToken2) {
                  if (err) return next(err);
                  User.login({email: 'user3@example.com', password: 'u3pass'},
                    function(err, accessToken3) {
                      if (err) return next(err);
                      next();
                    });
                },
              );
            },
          );
        },
        function(next) {
          user2.updateAttribute('email', 'user2Update@b.com', function(err, userInstance) {
            if (err) return next(err);
            assert.equal(userInstance.email, 'user2Update@b.com');
            next();
          });
        },
        function(next) {
          AccessToken.find({where: {userId: user1.pk}}, function(err, tokens1) {
            if (err) return next(err);
            AccessToken.find({where: {userId: user2.pk}}, function(err, tokens2) {
              if (err) return next(err);
              AccessToken.find({where: {userId: user3.pk}}, function(err, tokens3) {
                if (err) return next(err);

                expect(tokens1.length).to.equal(1);
                expect(tokens2.length).to.equal(0);
                expect(tokens3.length).to.equal(1);
                next();
              });
            });
          });
        },
      ], done);
    });

    it('invalidates correct sessions after changing email using updateAll', function(done) {
      let userSpecial, userNormal;
      async.series([
        function createSpecialUser(next) {
          User.create(
            {email: 'special@example.com', password: 'pass1', name: 'Special'},
            function(err, specialInstance) {
              if (err) return next(err);
              userSpecial = specialInstance;
              next();
            },
          );
        },
        function loginSpecialUser(next) {
          User.login({email: 'special@example.com', password: 'pass1'}, function(err, ats) {
            if (err) return next(err);
            next();
          });
        },
        function updateSpecialUser(next) {
          User.updateAll(
            {name: 'Special'},
            {email: 'superspecial@example.com'}, function(err, info) {
              if (err) return next(err);
              next();
            },
          );
        },
        function verifyTokensOfSpecialUser(next) {
          AccessToken.find({where: {userId: userSpecial.pk}}, function(err, tokens1) {
            if (err) return done(err);
            expect(tokens1.length, 'tokens - special user tokens').to.equal(0);
            next();
          });
        },
        assertPreservedTokens,
      ], done);
    });

    it('invalidates session when password is reset', function(done) {
      user.updateAttribute('password', 'newPass', function(err, user2) {
        if (err) return done(err);
        assertNoAccessTokens(done);
      });
    });

    it('preserves current session', function(done) {
      const options = {accessToken: originalUserToken1};
      user.updateAttribute('email', 'new@example.com', options, function(err) {
        if (err) return done(err);
        AccessToken.find({where: {userId: user.pk}}, function(err, tokens) {
          if (err) return done(err);
          const tokenIds = tokens.map(function(t) { return t.id; });
          expect(tokenIds).to.eql([originalUserToken1.id]);
          done();
        });
      });
    });

    it('forwards the "options" argument', function(done) {
      const options = {testFlag: true};
      const observedOptions = [];

      saveObservedOptionsForHook('access', User);
      saveObservedOptionsForHook('before delete', AccessToken);

      user.updateAttribute('password', 'newPass', options, function(err, updated) {
        if (err) return done(err);

        expect(observedOptions).to.eql([
          // prepareForTokenInvalidation - load current instance data
          {hook: 'access', testFlag: true},

          // validate uniqueness of User.email
          {hook: 'access', testFlag: true},

          // _invalidateAccessTokensOfUsers - deleteAll
          {hook: 'before delete', testFlag: true},
        ]);
        done();
      });

      function saveObservedOptionsForHook(name, model) {
        model.observe(name, function(ctx, next) {
          observedOptions.push(extend({hook: name}, ctx.options));
          next();
        });
      }
    });

    it('preserves other user sessions if their password is  untouched', function(done) {
      let user1, user2, user1Token;
      async.series([
        function(next) {
          User.create({email: 'user1@example.com', password: 'u1pass'}, function(err, u1) {
            if (err) return done(err);
            User.create({email: 'user2@example.com', password: 'u2pass'}, function(err, u2) {
              if (err) return done(err);
              user1 = u1;
              user2 = u2;
              next();
            });
          });
        },
        function(next) {
          User.login({email: 'user1@example.com', password: 'u1pass'}, function(err, at1) {
            User.login({email: 'user2@example.com', password: 'u2pass'}, function(err, at2) {
              assert(at1.userId);
              assert(at2.userId);
              user1Token = at1.id;
              next();
            });
          });
        },
        function(next) {
          user2.updateAttribute('password', 'newPass', function(err, user2Instance) {
            if (err) return next(err);
            assert(user2Instance);
            next();
          });
        },
        function(next) {
          AccessToken.find({where: {userId: user1.pk}}, function(err, tokens1) {
            if (err) return next(err);
            AccessToken.find({where: {userId: user2.pk}}, function(err, tokens2) {
              if (err) return next(err);
              expect(tokens1.length).to.equal(1);
              expect(tokens2.length).to.equal(0);
              assert.equal(tokens1[0].id, user1Token);
              next();
            });
          });
        },
      ], function(err) {
        done();
      });
    });

    // See https://github.com/strongloop/loopback/issues/3215
    it('handles subclassed user with no accessToken relation', () => {
      // setup a new LoopBack app, we don't want to use shared models
      app = loopback({localRegistry: true, loadBuiltinModels: true});
      app.set('_verifyAuthModelRelations', false);
      app.set('remoting', {errorHandler: {debug: true, log: false}});
      app.dataSource('db', {connector: 'memory'});
      const User = app.registry.createModel({
        name: 'user',
        base: 'User',
      });
      app.model(User, {dataSource: 'db'});
      app.enableAuth({dataSource: 'db'});
      expect(app.models.User.modelName).to.eql('user');

      return User.create(validCredentials)
        .then(u => {
          u.email = 'updated@example.com';
          return u.save();
          // the test passes when save() does not throw any error
        });
    });

    function assertPreservedTokens(done) {
      AccessToken.find({where: {userId: user.pk}}, function(err, tokens) {
        if (err) return done(err);
        const actualIds = tokens.map(function(t) { return t.id; });
        actualIds.sort();
        const expectedIds = [originalUserToken1.id, originalUserToken2.id];
        expectedIds.sort();
        expect(actualIds).to.eql(expectedIds);
        done();
      });
    }

    function assertNoAccessTokens(done) {
      AccessToken.find({where: {userId: user.pk}}, function(err, tokens) {
        if (err) return done(err);
        expect(tokens.length).to.equal(0);
        done();
      });
    }
  });

  describe('ctor', function() {
    it('exports default AccessToken model', function() {
      expect(User.accessToken, 'User.accessToken').to.be.a('function');
      expect(User.accessToken.modelName, 'modelName').to.eql('AccessToken');
    });
  });

  describe('ttl', function() {
    let User2;
    beforeEach(function() {
      User2 = loopback.User.extend('User2', {}, {ttl: 10});
    });
    it('should override ttl setting in based User model', function() {
      expect(User2.settings.ttl).to.equal(10);
    });
  });
});
