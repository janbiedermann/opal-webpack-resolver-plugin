'use strict';

const fs = require('fs');
const child_process = require('child_process');

module.exports = class OpalWebpackResolverPlugin {
    constructor(source, target) {
        const gemfile_path = 'Gemfile';
        const gemfile_lock_path = 'Gemfile.lock';
        const owl_cache_dir = '.owl_cache';
        const owl_cache_path = owl_cache_dir + '/load_paths.json';
        const owl_compiler_cache_dir = owl_cache_dir + '/cc';
        var owl_cache_mtime = 0;
        var must_generate_cache = false;

        var gemfile_mtime = fs.statSync(gemfile_path).mtimeMs;
        var gemfile_lock_mtime = fs.statSync(gemfile_lock_path).mtimeMs;

        fs.accessSync(gemfile_path, fs.constants.R_OK);
        fs.accessSync(gemfile_lock_path, fs.constants.R_OK);
        try {
            fs.accessSync(owl_cache_path, fs.constants.R_OK | fs.constants.W_OK);
        } catch (err) {
            if (!fs.existsSync(owl_cache_dir)) { fs.mkdirSync(owl_cache_dir); }
            if (!fs.existsSync(owl_compiler_cache_dir)) { fs.mkdirSync(owl_compiler_cache_dir); }
            fs.writeFileSync(owl_cache_path, JSON.stringify({}));
            owl_cache_mtime = fs.statSync(owl_cache_path).mtimeMs;
            must_generate_cache = true;
        }

        if (owl_cache_mtime === 0) { owl_cache_mtime = fs.statSync(owl_cache_path).mtimeMs; }

        if (gemfile_mtime > gemfile_lock_mtime) {
            console.exception("Gemfile is newer than Gemfile.lock, please run 'bundle install' or 'bundle update'!");
        }
        if (gemfile_lock_mtime > owl_cache_mtime || must_generate_cache) {
            this.opal_load_paths = this.get_load_paths();
            this.opal_load_path_entries = this.get_load_path_entries(this.opal_load_paths);
            fs.writeFileSync(owl_cache_path, JSON.stringify({
                opal_load_paths: this.opal_load_paths,
                opal_load_path_entries: this.opal_load_path_entries
            }));
        } else if (!this.owl_cache_fetched) {
            var owl_cache_from_file = fs.readFileSync(owl_cache_path);
            var owl_cache = JSON.parse(owl_cache_from_file.toString());
            this.opal_load_paths = owl_cache.opal_load_paths;
            this.opal_load_path_entries = owl_cache.opal_load_path_entries;
            this.owl_cache_fetched = true;
        }

        this.source = source;
        this.target = target;
    }

    apply(resolver) {
        // console.log("OWRP resolver: %O", resolver);
        const target = resolver.ensureHook(this.target);
        resolver.getHook(this.source).tapAsync("OpalWebpackResolverPlugin", (request, resolveContext, callback) => {
            // callback is only defined for tapAsync
            // for synchronous tap callback is not defined, how to return err and result then?
            if (request.request.endsWith('.rb') || request.request.endsWith('.js')) {
                //console.log("OWRP request path: ", request.path);
                //console.log("OWRP request request", request.request);
                var absolute_path = this.get_absolute_path(request.path, request.request);
                if (absolute_path) {
                    //console.log ("----> found here: ", absolute_path);
                    var result = Object.assign({}, request, {path: absolute_path});
                    callback(null, result);
                } else {
                    //console.error("!! not found! !!");
                    callback();
                }
            } else {
                // Any logic you need to create a new `request` can go here

                // stops current pipeline and starts over again with modified request
                // resolver.doResolve(this.target, request, null, callback);

                // without args continues pipeline
                callback();
            }
            // with args:
            // callback(error); // stops pipeline with error
            // callback(null, result); // stops pipeline with success result
        });
    }

    get_directory_entries(path, in_app) {
        if (!path.startsWith('/')) { return [] }
        if (!in_app && path.startsWith(process.cwd())) { return [] }
        if (!fs.existsSync(path)) { return [] }
        var directory_entries = [];
        var f = fs.openSync(path, 'r');
        var is_dir = fs.fstatSync(f).isDirectory();
        fs.closeSync(f);
        if (is_dir) {
            var entries = fs.readdirSync(path);
            var e_length = entries.length;
            for (var k = 0; k < e_length; k++) {
                var current_path = path + '/' + entries[k];
                if (fs.existsSync(current_path)) {
                    var fe = fs.openSync(current_path, 'r');
                    var se = fs.fstatSync(fe);
                    var eis_dir = se.isDirectory();
                    var eis_file = se.isFile();
                    fs.closeSync(fe);
                    if (eis_dir) {
                        var more_entries = this.get_directory_entries(current_path, in_app);
                        var m_length = more_entries.length;
                        for (var m = 0; m < m_length; m++) {
                            directory_entries.push(more_entries[m]);
                        }
                    } else if (eis_file) {
                        if (current_path.endsWith('.rb') || current_path.endsWith('.js')) {
                            directory_entries.push(current_path);
                        }
                    }
                }
            }
        }
        return directory_entries;
    }

    get_absolute_path(path, request) {
        var logical_filename_rb;
        var logical_filename_js;
        var absolute_filename;
        var module;

        // cleanup request, comes like './module.rb', we want '/module.rb'
        if (request.startsWith('./')) {
            module = request.slice(1);
        } else if (request.startsWith('/')) {
            module = request;
        } else {
            module = '/' + request;
        }

        // opal allows for require of
        // .rb, .js, .js.rb, look up all of them
        if (module.endsWith('.rb')) {
            logical_filename_rb = module;
            logical_filename_js = module.slice(0,module.length-2) + 'js';
        } else if (module.endsWith('.js')) {
            logical_filename_rb = module + '.rb';
            logical_filename_js = module;
        }

        var l = this.opal_load_paths.length;

        // look up known entries
        for (var i = 0; i < l; i++) {
            // try .rb
            absolute_filename = this.opal_load_paths[i] + logical_filename_rb;
            if (this.opal_load_path_entries.includes(absolute_filename)) {
                // check if file exists?
                // if (fs.existsSync(absolute_filename)) {
                return absolute_filename;
                // }
            }
            // try .js
            if (logical_filename_js) {
                absolute_filename = this.opal_load_paths[i] + logical_filename_js;
                if (this.opal_load_path_entries.includes(absolute_filename)) {
                    // check if file exists?
                    // if (fs.existsSync(absolute_filename)) {
                    return absolute_filename;
                    // }
                }
            }
        }

        // look up file system of app
        for (var i = 0; i < l; i++) {
            if (this.opal_load_paths[i].startsWith(process.cwd())) {
                // try .rb
                absolute_filename = this.opal_load_paths[i] + logical_filename_rb;
                if (fs.existsSync(absolute_filename)) {
                    return absolute_filename;
                }
                // try .js
                if (logical_filename_js) {
                    absolute_filename = this.opal_load_paths[i] + logical_filename_js;
                    if (fs.existsSync(absolute_filename)) {
                        return absolute_filename;
                    }
                }
            }
        }

        // check current path
        absolute_filename = path + logical_filename_rb;
        if (absolute_filename.startsWith(process.cwd())) {
           if (fs.existsSync(absolute_filename)) {
               return absolute_filename;
           }
        }
        // error('opal-webpack-loader: Unable to locate module "' + logical_path + '" included by ' + requester);
        return null;
    }

    get_load_paths() {
        var load_paths;
        if (fs.existsSync('bin/rails')) {
            load_paths = child_process.execSync('bundle exec rails runner ' +
                '"puts (Rails.configuration.respond_to?(:assets) ? ' +
                '(Rails.configuration.assets.paths + Opal.paths).uniq : ' +
                'Opal.paths); exit 0"');
        } else {
            load_paths = child_process.execSync('bundle exec ruby -e "Bundler.require; puts Opal.paths; exit 0"');
        }
        var load_path_lines = load_paths.toString().split('\n');
        var lp_length = load_path_lines.length;
        if (load_path_lines[lp_length-1] === '' || load_path_lines[lp_length-1] == null) {
            load_path_lines.pop();
        }
        return load_path_lines;
    }

    get_load_path_entries(load_paths) {
        var load_path_entries = [];
        var lp_length = load_paths.length;
        for (var i = 0; i < lp_length; i++) {
            var dir_entries = this.get_directory_entries(load_paths[i], false);
            var d_length = dir_entries.length;
            for (var k = 0; k < d_length; k++) {
                load_path_entries.push(dir_entries[k]);
            }
        }
        return load_path_entries;
    }
};
