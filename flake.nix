{
  description = "Pushwork: Bidirectional directory synchronization using Automerge CRDTs";

  inputs = {
    command-utils.url = "git+https://codeberg.org/expede/nix-command-utils";
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
  };

  outputs = {
    self,
    command-utils,
    flake-utils,
    nixpkgs,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {inherit system;};

      nodejs = pkgs.nodejs_24;
      pnpm-pkg = pkgs.pnpm;
      pnpm' = "${pnpm-pkg}/bin/pnpm";

      asModule = command-utils.asModule.${system};
      cmd = command-utils.cmd.${system};
      pnpm = command-utils.pnpm.${system};

      pnpm-cfg = {pnpm = pnpm';};

      menu =
        command-utils.commands.${system}
        [
          (pnpm.build pnpm-cfg)
          (pnpm.dev pnpm-cfg)
          (pnpm.install pnpm-cfg)
          (pnpm.lint pnpm-cfg)
          (pnpm.test pnpm-cfg)
          (pnpm.typecheck pnpm-cfg)
          (asModule {
            "clean" = cmd "Remove dist and node_modules" "rm -rf dist node_modules";
            "start" = cmd "Run pushwork CLI" "node dist/cli.js \"$@\"";
            "sync" = cmd "Build and run sync" "${pnpm'} build && node dist/cli.js sync \"$@\"";
            "watch" = cmd "Watch, build, and sync loop" "node dist/cli.js watch \"$@\"";
          })
        ];
    in {
      devShells.default = pkgs.mkShell {
        name = "Pushwork Dev Shell";

        nativeBuildInputs =
          [
            nodejs
            pkgs.nodePackages.vscode-langservers-extracted
            pkgs.typescript
            pkgs.typescript-language-server
            pnpm-pkg
          ]
          ++ menu;

        shellHook = ''
          menu
        '';
      };

      formatter = pkgs.alejandra;
    });
}
