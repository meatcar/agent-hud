{
  perSystem =
    { pkgs, ... }:
    let
      package = builtins.fromJSON (builtins.readFile ../../package.json);
      runtimeSource = pkgs.lib.fileset.toSource {
        root = ../..;
        fileset = ../../src;
      };
      testSource = pkgs.lib.fileset.toSource {
        root = ../..;
        fileset = pkgs.lib.fileset.unions [
          ../../scripts
          ../../src
          ../../test
        ];
      };
      agent-hud-src = pkgs.stdenv.mkDerivation {
        pname = "agent-hud-src";
        inherit (package) version;
        src = runtimeSource;
        dontBuild = true;
        installPhase = ''
          mkdir -p $out
          cp -r src $out/
        '';
      };
    in
    {
      packages.default =
        (pkgs.writeShellApplication {
          name = "agent-hud";
          runtimeInputs = [ pkgs.bun ];
          text = ''
            exec bun "${agent-hud-src}/src/index.ts" "$@"
          '';
        }).overrideAttrs
          (_: {
            pname = "agent-hud";
            inherit (package) version;
            name = "agent-hud-${package.version}";
          });

      checks.tests =
        pkgs.runCommand "agent-hud-tests-${package.version}"
          {
            src = testSource;
            nativeBuildInputs = [
              pkgs.bun
              pkgs.git
              pkgs.jujutsu
            ];
          }
          ''
                export HOME="$TMPDIR/home"
                export XDG_CONFIG_HOME="$TMPDIR/config"
                mkdir -p "$HOME" "$XDG_CONFIG_HOME" source
                cp -r "$src"/. source/
                chmod -R u+w source
            cd source
            bun test \
              test/unit \
              test/integration/cmd-helper.test.ts \
              test/integration/commands.test.ts \
              test/integration/config.test.ts \
              test/integration/gc.test.ts \
              test/integration/rate-limits.test.ts \
              test/integration/session.test.ts \
              test/integration/vcs.test.ts
            # Nix sandboxes intentionally lack /usr/bin/env, so the one test that
            # Directly executes an env-shebang build belongs to the native package
            # Gate. Every other entrypoint contract remains hermetic here.
            bun test test/integration/index.test.ts \
              --test-name-pattern '^(?!.*packaged build)'
            touch "$out"
          '';
    };
}
