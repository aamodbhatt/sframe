#![forbid(unsafe_code)]

use clap::{Parser, Subcommand};
use serde_json::json;
use smallframe_core::{canonical_json, hex_digest, package_digest};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Parser)]
#[command(name = "smallframe", version, about = "Smallframe internal local CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Identity {
        #[command(subcommand)]
        command: IdentityCommand,
    },
    New {
        name: String,
    },
    Validate {
        path: PathBuf,
    },
    Pack {
        path: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    Dev {
        path: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
enum IdentityCommand {
    Init,
    Export,
    Import { path: PathBuf },
}

fn manifest_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join("smallframe.json")
    } else {
        path.to_path_buf()
    }
}

fn validate(path: &Path) -> Result<(), String> {
    let manifest = fs::read_to_string(manifest_path(path))
        .map_err(|error| format!("READ_MANIFEST: {error}"))?;
    let canonical = canonical_json(&manifest).map_err(|error| format!("MANIFEST_JSON: {error}"))?;
    let digest = package_digest(&manifest).map_err(|error| format!("PACKAGE_DIGEST: {error}"))?;
    println!("{}", serde_json::to_string_pretty(&json!({"canonicalManifestBytes": canonical.len(), "packageDigest": hex_digest(&digest)})).map_err(|error| error.to_string())?);
    Ok(())
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Validate { path } => validate(&path),
        Command::New { name } => {
            let target = PathBuf::from("examples").join(&name);
            if target.exists() {
                Err("VALIDATION: target exists; refusing to overwrite".to_owned())
            } else {
                fs::create_dir_all(target.join("src")).map_err(|error| error.to_string()).and_then(|_| { fs::write(target.join("README.md"), "# Smallframe starter\n\nAdapt this local starter to the SDK contract.\n").map_err(|error| error.to_string()) })
            }
        }
        Command::Pack { path, output: _ } => Err(format!(
            "PACK_NOT_READY: deterministic archive implementation is staged for the Phase 1 package-core slice ({})",
            path.display()
        )),
        Command::Dev { path } => {
            println!(
                "local development path: {}",
                path.unwrap_or_else(|| PathBuf::from("examples/decision-board"))
                    .display()
            );
            Ok(())
        }
        Command::Identity { command } => match command {
            IdentityCommand::Init => Err(
                "IDENTITY_STORE_NOT_READY: Phase 1 vault implementation is not yet complete"
                    .to_owned(),
            ),
            IdentityCommand::Export => Err("IDENTITY_STORE_NOT_READY".to_owned()),
            IdentityCommand::Import { path: _ } => Err("IDENTITY_STORE_NOT_READY".to_owned()),
        },
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
