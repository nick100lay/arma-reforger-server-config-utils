// Test suite for tools/cscript.mjs (the Enforce Script reader).
//
//   node tests/cscript-tests.mjs
//
// The fixtures are written here as text, so the suite pins the *reading rules* rather than one build's
// content: the game's own scripts live inside 2 GB `.pak` archives and cannot be committed, and a
// captured file would pin today's code instead of the reader's decisions. Each test exists because
// the corpus forced a decision, and the decision is what is asserted:
//
//  * a method is told from a field by the first `(` / `=` / `;` -- `int x = f(1);` is a field with a
//    call in its initialiser, `void F(int a)` is a method;
//  * a body is skipped by bracket matching, so `{ { ... } }` (a defensive block at the top of a
//    method, which SCR_ScenarioFrameworkAIActionSetRadioFrequency.c really has) must not end the body
//    early -- that bug silently ate one `}` per method and reported the file as unbalanced;
//  * `modded class X : Base` and `modded enum X` are ordinary declarations with a flag, and a modded
//    declaration is *not* a duplicate of the original next to it;
//  * an enum value is an expression (`= 1 << 0`), an omitted value continues the previous one, and a
//    `modded enum` continues the *original's* numbering -- knowable only when the original is in the
//    searched sources, so "unknown" is a value too;
//  * a doc comment has five spellings, a group marker (`\addtogroup`, `/// @ingroup`) documents a
//    group and not the class below it, a plain `/* ... */` banner is reported separately, and `//!<`
//    documents what precedes it;
//  * `#ifdef` wraps declarations, so a declaration inside one records its condition, two declarations
//    are only duplicates under the same condition, and an unclosed `#ifdef` is an error;
//  * duplicates are case- and kind-sensitive: `GetPlaceHolderText` and `GetPlaceholderText` coexist in
//    one class in vanilla, and `typedef int X;` sits beside `class X`;
//  * a constructor and a destructor are not a duplicate pair (`void X()` / `void ~X()`).
//
// The CLI is exercised as a real child process with its output written to files, so the suite keeps
// working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseScript,
  parseText,
  docOf,
  docText,
  docTags,
  joinTokens,
  declarationsOf,
  findDeclaration,
  findDeclarations,
  evaluateExpression,
  numberEnum,
  numberEnumWithSources,
  definitionRow,
  findDefinitions,
  schemaOf,
  inheritanceChain,
  subclassTree,
  subclassesOf,
  moddedCopiesOf,
  declarationsNamed,
  checkScript,
  ScriptUniverse,
  parseParams,
  splitTopLevel,
  bareTypeName,
  qualifiedName,
  ownerChain,
  enclosingAddon,
  scriptFilesUnder,
  pakFilesUnder,
  parseSourceSpec,
  parseLineSpec,
  splitLines,
  EXTENSIONS,
} from "../tools/cscript.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "cscript.mjs");
const tmp = join(root, "tests", ".tmp-cscript");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Assert deep equality by JSON, printing both sides when they differ. */
function same(what, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(what, a === b, a === b ? "" : `got ${a}, want ${b}`);
}

/** Write a fixture into the temp tree and return its path. */
function fixture(name, text, { bom = false, crlf = false } = {}) {
  const body = crlf ? text.replace(/\n/g, "\r\n") : text;
  const prefix = bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  const path = join(tmp, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([prefix, Buffer.from(body, "utf8")]));
  return path;
}

/** Run the CLI, with stdout and stderr going to files rather than to pipes. */
function runCli(args) {
  const outPath = join(tmp, "cli.out");
  const errPath = join(tmp, "cli.err");
  writeFileSync(outPath, "");
  writeFileSync(errPath, "");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let status;
  try {
    status = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", out, err] }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const text = readFileSync(outPath, "utf8");
  return { status, out: text, err: readFileSync(errPath, "utf8"), json: () => JSON.parse(text) };
}

/** The problems of one severity, by code, sorted: the compact half of an assertion. */
function codes(problems, severity = null) {
  return problems
    .filter((p) => !severity || p.severity === severity)
    .map((p) => p.code)
    .sort();
}

/** A declaration by name, or a thrown assertion. */
function decl(script, name) {
  const found = findDeclaration(script, name);
  if (!found) throw new Error(`no declaration named ${name} in ${script.name}`);
  return found;
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// ---------------------------------------------------------------------------
// One fixture that holds (almost) everything a script can have
// ---------------------------------------------------------------------------
const everything = `/*
==================================
Do not modify, this script is generated
==================================
*/

//! A weapon component. Every weapon has one.
//! Second doc line.
[BaseContainerProps(configRoot: true), NonSerialized()]
modded class SCR_WeaponComponent : SCR_Component
{
	[Attribute("0", uiwidget: UIWidgets.CheckBox, desc: "A flag", params: "0 1", "0 500")]
	protected bool m_bFlag = false; //!< the flag itself

	/*!
	\\brief The params.
	\\param[in] a first
	*/
	protected ref array<ref SCR_Item> m_aItems = {};

	ref SCR_Item m_aStatic[4];
	static const float SPEED = 0.25;
	const string NAME = "weapon";

	//------------------------------------------------------------------------------------------------
	//!
	//! \\param[in] msg the message
	//! \\return the answer
	int GetAnswer(int a, float b = 1.5, notnull IEntity c = null)
	{
		{
			if (a > 0)
			{
				return a;
			}
		}
		return 0;
	};

	static void OneLine() { }

	proto external string GetWorldFile();
	proto native void SetTime(int ms);
	sealed World GetWorld() { return null; }

	void SCR_WeaponComponent() { }
	void ~SCR_WeaponComponent() { }
	override void OnDelete() { super.OnDelete(); }
};

sealed class SCR_Sealed : SCR_Base
{
}

enum EWeaponType : EHitZoneGroup
{
	//! A rifle
	WT_NONE,
	WT_RIFLE,
	WT_FLAG = 1 << 4,
	WT_OR = WT_RIFLE | WT_FLAG,
	WT_LAST = WT_OR,
}

modded enum EWeaponType
{
	WT_MODDED,
}

typedef func ScriptInvokerIntMethod;
typedef array<string> StringArray;

void GlobalFunction(int a);
int GlobalVariable = 3;
`;

const script = parseScript(everything, { name: "Weapons.c" });

// The file declares: modded class, sealed class, enum, modded enum, 2 typedefs, 1 function,
// 1 variable -- in source order, each its own kind.
same(
  "every declaration kind is read, in source order",
  script.declarations.map((d) => `${d.kind}:${d.name}`),
  [
    "class:SCR_WeaponComponent",
    "class:SCR_Sealed",
    "enum:EWeaponType",
    "enum:EWeaponType",
    "typedef:ScriptInvokerIntMethod",
    "typedef:StringArray",
    "function:GlobalFunction",
    "variable:GlobalVariable",
  ],
);
same("a clean fixture has no parse problems", script.problems, []);

const weapon = decl(script, "SCR_WeaponComponent");
check("a modded class is a class with a flag", weapon.kind === "class" && weapon.modded === true);
same("the base clause of a modded class is kept", weapon.base, "SCR_Component");
same("a class signature keeps modded and the base", weapon.signature, "modded class SCR_WeaponComponent : SCR_Component");
same("the class range starts at its first attribute", everything.split("\n")[weapon.range.start - 1].startsWith("[BaseContainerProps"), true);
check("the class range ends at its closing brace", everything.split("\n")[weapon.range.end - 1].trim() === "};", `line ${weapon.range.end}`);
check("a class signature has its own range", weapon.signatureRange.start === weapon.range.start + 1, JSON.stringify(weapon.signatureRange));

// Doc comments: a run of `//!` lines above the attributes.
check("a run of //! lines is one docstring", weapon.doc?.marker === "//!" && weapon.doc.text.split("\n").length === 2, JSON.stringify(weapon.doc));
check("a docstring has a line range", weapon.doc.end - weapon.doc.start === 1 && everything.split("\n")[weapon.doc.start - 1].startsWith("//! A weapon"), JSON.stringify(weapon.doc));
check("a banner is not a docstring", weapon.banner === null, JSON.stringify(weapon.banner));

// Attributes: two in one bracket, named arguments, a positional argument after a named one.
same(
  "two attributes in one bracket are two attributes",
  weapon.attrs.map((a) => a.name),
  ["BaseContainerProps", "NonSerialized"],
);
check(
  "both attributes are on the same line",
  weapon.attrs.every((a) => a.line === weapon.signatureRange.start - 1),
  JSON.stringify(weapon.attrs.map((a) => a.line)),
);

// Fields.
const flagField = decl(script, "m_bFlag");
same("a later attribute set belongs to the field", flagField.attrs.map((a) => a.name), ["Attribute"]);
check(
  "an attribute's arguments are kept verbatim, with the positional one after the named one",
  flagField.attrs[0].args.includes("uiwidget: UIWidgets.CheckBox") && flagField.attrs[0].args.includes('"0 500"'),
  flagField.attrs[0].args,
);
check("a trailing //!< is the field's docstring", flagField.doc?.trailing === true && flagField.doc.text === "the flag itself");
const items = decl(script, "m_aItems");
same("a ref array of refs keeps the inner ref", items.signature, "ref array<ref SCR_Item> m_aItems");
same("a field initialiser is kept as written", items.init, "{}");
same("a field's type does not repeat its modifier", items.type, "array<ref SCR_Item>");
check("a field's ref modifier is a flag", items.ref === true);
same("a C-style array declarator is kept", decl(script, "m_aStatic").signature, "ref SCR_Item m_aStatic[4]");
same("modifier order is preserved as written", decl(script, "SPEED").signature, "static const float SPEED");
check("a block docstring on a field is read", items.doc?.marker === "/*!" && items.doc.text.startsWith("\\brief The params."));
check("a docstring's tags are extracted", items.doc.tags.some((t) => t.tag === "param[in]" && t.text === "a first"));
check("a field's visibility is separate from its signature", flagField.visibility === "protected");

// Methods.
const answer = decl(script, "GetAnswer");
same("a method signature includes defaults and modifiers", answer.signature, "int GetAnswer(int a, float b = 1.5, notnull IEntity c = null)");
same("a method's parameters are parsed", answer.params.map((p) => `${p.type}|${p.name}|${p.defaultValue}`), [
  "int|a|null",
  "float|b|1.5",
  "IEntity|c|null",
]);
same("a parameter modifier is kept", answer.params[2].modifiers, ["notnull"]);
check(
  "a nested block does not end the body",
  everything.split("\n").slice(answer.range.start - 1, answer.range.end).join("\n").includes("return 0;"),
  `${answer.range.start}-${answer.range.end}`,
);
check("a stray `;` after a body is tolerated", answer.hasBody === true && answer.range.end > answer.range.start);
check("a method signature is its declaration line", answer.signatureRange.start === answer.range.start);
check("a one-line body is a body", decl(script, "OneLine").hasBody === true);
check("a proto external method has no body", decl(script, "GetWorldFile").hasBody === false && decl(script, "GetWorldFile").proto === true && decl(script, "GetWorldFile").external === true);
check("a proto native method has no body", decl(script, "SetTime").hasBody === false && decl(script, "SetTime").native === true);
check("a sealed method is marked", decl(script, "GetWorld").sealed === true);
check("a constructor is recognised", findDeclarations(script, "SCR_WeaponComponent").some((d) => d.isConstructor));
check("a destructor is recognised", findDeclarations(script, "SCR_WeaponComponent").some((d) => d.isDestructor));
check("an override is marked", decl(script, "OnDelete").override === true);
check("a method's docstring sits above it, after the divider", decl(script, "GetAnswer").doc?.text.startsWith("\\param[in] msg"));
check("a method's docstring keeps its \\param and \\return tags", decl(script, "GetAnswer").doc.tags.length === 2 && decl(script, "GetAnswer").doc.tags[1].tag === "return");

// Enums.
const plainEnum = script.declarations.filter((d) => d.kind === "enum" && !d.modded)[0];
same("an enum's base is kept", plainEnum.base, "EHitZoneGroup");
numberEnum(plainEnum);
same(
  "enum values are numbered, and expressions evaluated",
  plainEnum.values.map((v) => `${v.name}=${v.value}`),
  ["WT_NONE=0", "WT_RIFLE=1", "WT_FLAG=16", "WT_OR=17", "WT_LAST=17"],
);
check("a value's own doc is read", plainEnum.values[0].doc?.text === "A rifle");
check("an omitted value is marked computed", plainEnum.values[1].computed === true);
check("an expression value is not marked computed", plainEnum.values[2].computed === false);

const moddedEnum = script.declarations.filter((d) => d.kind === "enum" && d.modded)[0];
numberEnum(moddedEnum);
same("a modded enum with no original has an unknown value", [moddedEnum.values[0].value, moddedEnum.values[0].valueKnown], [null, false]);
numberEnum(moddedEnum, { inheritedLast: 17 });
same("a modded enum continues the original's numbering", moddedEnum.values[0].value, 18);

// Typedefs and globals.
same("a func typedef keeps its alias", decl(script, "ScriptInvokerIntMethod").alias, "func");
same("a generic typedef keeps its alias", decl(script, "StringArray").alias, "array<string>");
same("a global function has no owner", decl(script, "GlobalFunction").owner, null);
same("a global variable is a variable, not a field", decl(script, "GlobalVariable").kind, "variable");

// ---------------------------------------------------------------------------
// Doc comments: the three ways vanilla writes them
// ---------------------------------------------------------------------------
// A generated file: banner, group marker, class -- no docstring at all. The group is reported, and
// the banner with it, rather than either being passed off as the class's docstring.
const generated = parseScript(`/*
Do not modify
*/

/*!
\\addtogroup Attributes
\\{
*/

class Attribute: UniqueAttribute
{
}

/*!
\\}
*/
`, { name: "Generated.c" });
const attribute = decl(generated, "Attribute");
same("a group marker names its group", attribute.group, "Attributes");
same("a banner is reported when there is no docstring", attribute.banner?.start, 1);
check("a group marker is not a docstring", attribute.doc === null);

// A hand-written class: `/// @ingroup` above the divider above the banner above the class.
const handWritten = parseScript(`/// @ingroup GameMode
//------------------------------------------------------------------------------------------------
/*
Brief: the game mode.
*/
class SCR_BaseGameMode : BaseGameMode
{
}
`, { name: "HandWritten.c" });
const gameMode = decl(handWritten, "SCR_BaseGameMode");
same("an @ingroup doc line names the group too", gameMode.group, "GameMode");
same("the banner above the class is the description", gameMode.banner?.text, "Brief: the game mode.");
check("no docstring is invented from a banner", gameMode.doc === null);

// Two blank lines end a comment block: the comment above belongs to nothing.
const detached = parseScript(`/* Not this class */


class A { }
`, { name: "Detached.c" });
same("two blank lines detach a comment", decl(detached, "A").banner, null);
// One blank line does not.
const attached = parseScript("/* Belongs to A */\n\nclass A { }\n", { name: "Attached.c" });
same("one blank line does not detach a comment", decl(attached, "A").banner?.text, "Belongs to A");

// docText/docTags on their own.
const tokenised = parseScript("//! one\n//! two\\param[out] x\n", { name: "Doc.c" });
same("a doc line loses its marker", docText(tokenised.comments[0]), "one");
same("a doc tag is split from its text", docTags("a\n\\return b\n@param x c")[1], { tag: "param", text: "x c" });
void docOf;

// ---------------------------------------------------------------------------
// The preprocessor wraps declarations
// ---------------------------------------------------------------------------
const conditional = parseScript(`class A
{
	#ifdef AI_DEBUG
	protected bool m_bDebug;
	#else
	protected bool m_bDebug;
	#endif
	#ifdef AI_DEBUG
	void OnlyInDebug();
	#endif
}
`, { name: "Conditional.c" });
same("both branches of #ifdef are parsed, each with its condition", decl(conditional, "A").members.map((m) => `${m.name}:${m.conditions.join("&")}`), [
  "m_bDebug:#ifdef AI_DEBUG",
  "m_bDebug:!#ifdef AI_DEBUG",
  "OnlyInDebug:#ifdef AI_DEBUG",
]);
same("a declaration repeated in two branches is not a duplicate", codes(checkScript(conditional), "error"), []);
same("an unclosed #ifdef is an error", codes(parseScript("#ifdef X\nclass A { }\n").problems), ["unclosed-ifdef"]);
same("a stray #endif is an error", codes(parseScript("#endif\nclass A { }\n").problems), ["stray-endif"]);
same("an unknown directive is a warning", codes(parseScript("#frobnicate x\nclass A { }\n").problems), ["unknown-directive"]);
same("a #pragma is tolerated without a complaint", codes(parseScript("#pragma once\nclass A { }\n").problems), []);
same("a #define is recorded, not parsed as code", parseScript("#define A 1\nclass B { }\n").declarations.map((d) => d.name), ["B"]);

// ---------------------------------------------------------------------------
// Things that do not parse, and the shape of the recovery
// ---------------------------------------------------------------------------
same("an unterminated string is an error", codes(parseScript('class A { string s = "oops; }\n').problems).includes("unterminated-string"), true);
check("an error carries a line", parseScript('class A { string s = "oops; }\n').problems[0].line === 1);
same("an unterminated block comment is an error", codes(parseScript("/*\nclass A { }\n").problems), ["unterminated-comment"]);
same("an unclosed class is an error", codes(parseScript("class A { void F() { } \n").problems), ["unclosed-class"]);
same("a stray closing brace at file scope is an error", codes(parseScript("}\n").problems), ["stray-brace"]);

// A method header with no braces: RHS-StatusQuo really writes this, and the statement must not be
// mistaken for a field named `return`.
const noBody = parseScript("class A\n{\n\toverride UIInfo GetUIInfoScript()\n\t\treturn null;\n\tvoid Ok() { }\n}\n", { name: "NoBody.c" });
same("a method with neither body nor `;` is an error", codes(noBody.problems), ["method-without-body"]);
same("the bodyless method is kept and the stray statement is not a member", decl(noBody, "A").members.map((m) => m.name), ["GetUIInfoScript", "Ok"]);

// A field with no `;` at all: one ships in vanilla (EntitySerializerDefaultSpawnData.c).
const noSemi = parseScript("class A\n{\n\tResourceName Prefab\n\n}\n", { name: "NoSemi.c" });
same("a field without `;` is a note, not an error", codes(noSemi.problems), ["field-without-semicolon"]);
same("the field is still declared", decl(noSemi, "A").members.map((m) => m.name), ["Prefab"]);

// The attribute shapes the corpus and the wiki demand.
const attrs = parseScript(`[BaseContainerProps(), SCR_ContainerAIActionTitle()]
class A
{
	[Attribute("100", desc: "Maximum count of children.", "0 500")]
	int m_iMax;
	[Attribute(defvalue: "1", uiwidget: UIWidgets.ComboBox, enums: { ParamEnum("Zero", "0"), ParamEnum("One", "1"), })]
	int m_iEnum;
	[Attribute("0", UIWidgets.Object, "Fast init")];
	int m_iSpaced;
	[RplProp(onRplName: "OnChanged", condition: RplCondition.Custom)]
	int m_iRpl;
}
`, { name: "Attrs.c" });
same("a class attribute and a field attribute are told apart", decl(attrs, "A").attrs.map((a) => a.name), ["BaseContainerProps", "SCR_ContainerAIActionTitle"]);
same("a positional argument after a named one does not stop the parse", decl(attrs, "A").members.map((m) => m.name), ["m_iMax", "m_iEnum", "m_iSpaced", "m_iRpl"]);
check(
  "an array literal with a trailing comma is kept verbatim",
  decl(attrs, "m_iEnum").attrs[0].args.includes('ParamEnum("One", "1"), }'),
  decl(attrs, "m_iEnum").attrs[0].args,
);
same("a `;` after an attribute does not lose the attribute", decl(attrs, "m_iSpaced").attrs.map((a) => a.name), ["Attribute"]);

// `#include` inside a class body, and a `>>` that closes two generics.
const include = parseScript(`class A
{
	#include "scripts/Game/FileToInclude.c"
	ref array<array<int>> m_aNested;
}
`, { name: "Include.c" });
same("an #include inside a class body is a directive, not a member", decl(include, "A").members.map((m) => m.name), ["m_aNested"]);
same("nested generics keep both closing brackets", decl(include, "m_aNested").signature, "ref array<array<int>> m_aNested");

// A string continued with a backslash, with CRLF endings (RHS-StatusQuo writes one); a BOM is fine.
same("a backslash continues a string across a CRLF newline", parseText(Buffer.from('class A\r\n{\r\n\tstring m_s = "one \\\r\n two";\r\n}\r\n', "utf8")).problems, []);
same("a UTF-8 BOM does not break the parse", parseText(Buffer.from("\ufeffclass A { }\n", "utf8")).declarations.length, 1);

// A template class and `extends`.
const template = parseScript(`class Item<Class T> extends Managed
{
	protected T m_Data;
	T GetData() { return m_Data; }
}
`, { name: "Template.c" });
same("a template class keeps its type parameters", decl(template, "Item").signature, "class Item<Class T> extends Managed");
same("a template class's type parameters are parsed", decl(template, "Item").typeParams, ["Class T"]);
same("the `extends` base is the base", decl(template, "Item").base, "Managed");

// ---------------------------------------------------------------------------
// Signature rendering
// ---------------------------------------------------------------------------
same("a signature gets spaces around `:`", joinTokens([{ value: "class" }, { value: "X" }, { value: ":" }, { value: "Y" }]), "class X : Y");
same("a parameter list has no space before `(`", joinTokens([{ value: "void" }, { value: "F" }, { value: "(" }, { value: ")" }]), "void F()");
same("a destructor keeps its tilde tight", joinTokens([{ value: "void" }, { value: "~" }, { value: "X" }, { value: "(" }, { value: ")" }]), "void ~X()");
same("a default value keeps spaces around `=`", joinTokens([{ value: "int" }, { value: "a" }, { value: "=" }, { value: "5" }]), "int a = 5");
same("nested generics are closed without a space", joinTokens([{ value: "array" }, { value: "<" }, { value: "array" }, { value: "<" }, { value: "int" }, { value: ">>" }]), "array<array<int>>");
same("a base type name loses its arguments", bareTypeName("array<ref X>"), "array");
same("a qualified name walks the owners", qualifiedName(decl(script, "GetAnswer")), "SCR_WeaponComponent.GetAnswer");
same("the owner chain of a member is its class", ownerChain(decl(script, "GetAnswer")).map((d) => d.name), ["SCR_WeaponComponent"]);

const params = parseParams(
  [
    { type: "ident", value: "map" }, { type: "punct", value: "<" }, { type: "ident", value: "string" },
    { type: "punct", value: "," }, { type: "ident", value: "int" }, { type: "punct", value: ">" },
    { type: "ident", value: "m" }, { type: "punct", value: "," }, { type: "ident", value: "out" },
    { type: "ident", value: "int" }, { type: "ident", value: "n" },
  ],
  "",
);
same("a comma inside a generic does not split a parameter", params.map((p) => p.signature), ["map<string, int> m", "out int n"]);
same("splitTopLevel keeps a generic as one part", splitTopLevel([{ type: "punct", value: "<" }, { type: "punct", value: ">>" }], "").length, 1);

// ---------------------------------------------------------------------------
// Enum expressions
// ---------------------------------------------------------------------------
same("a shift expression evaluates", evaluateExpression([{ type: "number", value: "1" }, { type: "punct", value: "<<" }, { type: "number", value: "4" }], {}), 16);
same("a bitwise or of members evaluates", evaluateExpression([{ type: "ident", value: "A" }, { type: "punct", value: "|" }, { type: "ident", value: "B" }], { A: 2, B: 3 }), 3);
same("a hex literal evaluates", evaluateExpression([{ type: "number", value: "0x10" }], {}), 16);
same("parentheses evaluate", evaluateExpression([{ type: "punct", value: "(" }, { type: "number", value: "2" }, { type: "punct", value: "+" }, { type: "number", value: "3" }, { type: "punct", value: ")" }, { type: "punct", value: "*" }, { type: "number", value: "2" }], {}), 10);
same("an unknown name makes the value unknown", evaluateExpression([{ type: "ident", value: "Nope" }], {}), null);

// ---------------------------------------------------------------------------
// A universe of two addons: one declares a class, the other replaces it
// ---------------------------------------------------------------------------
const addons = join(tmp, "addons");
const vanillaAddon = join(addons, "Vanilla");
const modAddon = join(addons, "MyMod");
fixture("addons/Vanilla/addon.gproj", 'GameProject {\n ID "Vanilla"\n}\n');
fixture("addons/MyMod/addon.gproj", 'GameProject {\n ID "MyMod"\n}\n');
const basePath = fixture("addons/Vanilla/Scripts/Game/Base.c", `//! The root of the test tree.
class SCR_Root
{
}

//! The base of everything.
class SCR_Thing : SCR_Root
{
	//! Health of the thing.
	protected int m_iHealth;

	//! Heal it.
	void Heal(int amount)
	{
	}

	void Damage(int amount)
	{
	}
}

class SCR_Child : SCR_Thing
{
	void Heal(int amount)
	{
	}
}

class SCR_GrandChild : SCR_Child
{
}

enum EThingKind
{
	KIND_A,
	KIND_B,
}
`);
fixture("addons/MyMod/Scripts/Game/BaseModded.c", `//! A mod's replacement.
modded class SCR_Thing : SCR_Root
{
	//! Heal it, but better.
	override void Heal(int amount)
	{
		super.Heal(amount);
	}

	void ModOnly()
	{
	}
}

modded enum EThingKind
{
	KIND_MODDED,
}
`);
fixture("addons/MyMod/Scripts/Game/Other.c", "class SCR_Lonely\n{\n}\n");

const universe = new ScriptUniverse({
  sources: [
    { kind: "addon", value: vanillaAddon },
    { kind: "addon", value: modAddon },
  ],
});
const sources = universe.sources();
same("an addon is read as the .c files under it", sources.filter((s) => s.addon === "Vanilla").length, 1);
same("both addons are in the universe", sources.length, 3);
same("the declaration index finds a class by name", universe.candidateSources("SCR_Thing").length, 2);

const found = findDefinitions("SCR_Thing", { universe });
same("both the original and the modded copy are found by default", found.rows.map((r) => `${r.modded ? "modded" : "original"}:${r.source.addon}`), ["original:Vanilla", "modded:MyMod"]);
check("a hit carries its source and line range", found.rows[0].start === 7 && found.rows[0].end === 20, `${found.rows[0].start}-${found.rows[0].end}`);
check("a class hit carries its docstring", found.rows[0].doc?.text === "The base of everything.");
same("--original selects the original only", findDefinitions("SCR_Thing", { universe, originalOnly: true }).rows.map((r) => r.modded), [false]);
same("--only-modded selects the modded copy only", findDefinitions("SCR_Thing", { universe, moddedOnly: true }).rows.map((r) => r.modded), [true]);
same("--kind class does not fall back to members", findDefinitions("Heal", { universe, kind: "class" }).rows, []);

const method = findDefinitions("SCR_Thing.Heal", { universe });
same("a qualified needle finds the method in both copies", method.rows.map((r) => `${r.kind}:${r.modded}`), ["method:false", "method:true"]);
check("a method hit carries its class's range", method.rows[0].owner.start === 7 && method.rows[0].owner.end === 20, JSON.stringify(method.rows[0].owner));
check("a method hit carries its own range", method.rows[0].start === 13 && method.rows[0].end === 15, `${method.rows[0].start}-${method.rows[0].end}`);
same("a bare member name falls back to members", findDefinitions("Heal", { universe }).rows.map((r) => r.qualifiedName).sort(), ["SCR_Child.Heal", "SCR_Thing.Heal", "SCR_Thing.Heal"]);
same("a bare name is looked up among types first", findDefinitions("SCR_Child", { universe }).rows.map((r) => r.kind), ["class"]);
same("an enum member is found by Enum.MEMBER", findDefinitions("EThingKind.KIND_A", { universe }).rows.map((r) => `${r.kind}:${r.name}`), ["enumValue:KIND_A"]);
check("an enum member hit carries its enum's range", findDefinitions("EThingKind.KIND_A", { universe }).rows[0].owner?.name === "EThingKind");
same("a needle that matches nothing is an empty result", findDefinitions("NoSuchClass", { universe }).rows.length, 0);
same("a regex needle matches names, not only file text", findDefinitions("^SCR_", { universe, regex: true }).rows.map((r) => r.name).sort(), ["SCR_Child", "SCR_GrandChild", "SCR_Lonely", "SCR_Root", "SCR_Thing", "SCR_Thing"]);

// Inheritance: the mod's copy is a step of the chain, and the base is followed through the universe.
const thingDecl = declarationsNamed("SCR_Thing", universe).find((f) => !f.decl.modded);
const chain = inheritanceChain(thingDecl.decl, thingDecl.source, { universe, max: 8 });
same("the chain starts with the class, then the modded copy, then the base", chain.rows.map((r) => `${r.depth}:${r.role}:${r.modded}`), [
  "0:root:false",
  "0:modded:true",
  "1:ancestor:false",
]);
same("the chain names the bases", chain.rows.map((r) => r.base), ["SCR_Root", "SCR_Root", null]);
same("a complete chain has no problems", chain.problems, []);
check("the last row is the root class", chain.rows[2].name === "SCR_Root");

const moddedDecl = declarationsNamed("SCR_Thing", universe).find((f) => f.decl.modded);
const moddedChain = inheritanceChain(moddedDecl.decl, moddedDecl.source, { universe, max: 8 });
same("a modded class's chain reaches the original it replaces", moddedChain.rows.map((r) => r.role), ["root", "original", "ancestor"]);

// A base that is not in the searched sources is a warning, not a guess.
const lonelyUniverse = new ScriptUniverse({ sources: [{ kind: "addon", value: modAddon }] });
const lonelyDecl = declarationsNamed("SCR_Thing", lonelyUniverse)[0];
const lonelyChain = inheritanceChain(lonelyDecl.decl, lonelyDecl.source, { universe: lonelyUniverse, max: 8 });
same("an unresolvable base is a warning", codes(lonelyChain.problems, "warning").includes("base-not-found"), true);
same("an absent original of a modded class is a warning too", codes(lonelyChain.problems, "warning").includes("modded-original-missing"), true);
lonelyUniverse.close();

// A cycle is reported, not followed forever.
fixture("addons/Loop/Cycle.c", "class SCR_LoopA : SCR_LoopB { }\nclass SCR_LoopB : SCR_LoopA { }\n");
const loopUniverse = new ScriptUniverse({ sources: [{ kind: "addon", value: join(addons, "Loop") }] });
const loopDecl = declarationsNamed("SCR_LoopA", loopUniverse)[0];
same("an inheritance loop is an error", codes(inheritanceChain(loopDecl.decl, loopDecl.source, { universe: loopUniverse, max: 8 }).problems), ["cyclic-inheritance"]);
loopUniverse.close();

// Subclasses: direct children, transitive ones, and the modded copies of a node.
const tree = subclassTree("SCR_Thing", { universe, maxDepth: 0 });
same("the tree finds the direct subclass", tree.root.children.map((c) => c.name), ["SCR_Child"]);
same("the tree is transitive", tree.root.children[0].children.map((c) => c.name), ["SCR_GrandChild"]);
same("a modded copy of a node is reported with it", tree.root.declarations.map((d) => d.modded), [false, true]);
same("the tree counts the subclasses below the root", tree.total, 2);
const shallow = subclassTree("SCR_Thing", { universe, maxDepth: 1 });
check("--depth stops the tree", shallow.root.children.length === 1 && shallow.root.children[0].children.length === 0);
same("subclassesOf finds only direct children", subclassesOf("SCR_Thing", universe).map((s) => s.name), ["SCR_Child"]);
same("moddedCopiesOf finds the replacement", moddedCopiesOf("SCR_Thing", universe).length, 1);

// Schema: fields, methods, docstrings, and the inherited half.
const thingSource = { kind: "file", display: basePath, path: basePath, addon: "Vanilla" };
const schema = schemaOf(thingDecl.decl, thingDecl.source);
same("a class schema lists its fields", schema.fields.map((f) => f.name), ["m_iHealth"]);
same("a class schema lists its methods", schema.methods.map((m) => m.name), ["Heal", "Damage"]);
check("a field carries its visibility and docstring", schema.fields[0].visibility === "protected" && schema.fields[0].doc?.text === "Health of the thing.");
check("a method carries its docstring", schema.methods[0].doc?.text === "Heal it.");
const childScript = parseScript(readFileSync(basePath, "utf8"), { name: basePath });
const inheritedSchema = schemaOf(decl(childScript, "SCR_Child"), thingSource, { inherited: true, universe });
check("--inherited brings in the base's members", inheritedSchema.inherited?.[0]?.members.some((m) => m.name === "Damage"), JSON.stringify(inheritedSchema.inherited?.map((g) => g.name)));
check("an overridden method is not repeated from the base", !inheritedSchema.inherited[0].members.some((m) => m.name === "Heal"));

// A modded enum's values continue the original's, which only the universe can know.
const moddedEnumDecl = declarationsNamed("EThingKind", universe).find((f) => f.decl.modded);
numberEnumWithSources(moddedEnumDecl.decl, { universe });
same("a modded enum continues the original's numbering", moddedEnumDecl.decl.values.map((v) => `${v.name}=${v.value}`), ["KIND_MODDED=2"]);
check("the original enum is located and reported", moddedEnumDecl.decl.originalResolved?.start > 0);

// check: a modded class whose original is absent is a warning; with the original present, silence.
// The fixture holds one modded class and one modded enum, so both are reported.
const modOnly = new ScriptUniverse({ sources: [{ kind: "addon", value: modAddon }] });
const modScript = modOnly.parse(modOnly.sources().find((s) => s.display.endsWith("BaseModded.c")));
same("a modded class and enum with no originals in the sources warn", codes(checkScript(modScript, { universe: modOnly }), "warning"), ["modded-original-missing", "modded-original-missing"]);
same("with the originals present there is nothing to report", codes(checkScript(modScript, { universe }), "warning"), []);
modOnly.close();

// A modded class that declares a different base than the original is a warning.
fixture("addons/WrongBase/Scripts/Game/WrongBase.c", "modded class SCR_Child : SomethingElse\n{\n}\n");
const wrongUniverse = new ScriptUniverse({
  sources: [
    { kind: "addon", value: vanillaAddon },
    { kind: "addon", value: join(addons, "WrongBase") },
  ],
});
const wrongScript = wrongUniverse.parse(wrongUniverse.sources().find((s) => s.display.endsWith("WrongBase.c")));
same("a modded class with a different base than the original warns", codes(checkScript(wrongScript, { universe: wrongUniverse }), "warning"), ["modded-base-mismatch"]);
wrongUniverse.close();
universe.close();

// ---------------------------------------------------------------------------
// check: the local rules, one fixture each
// ---------------------------------------------------------------------------
same("a constructor and a destructor are not a duplicate pair", codes(checkScript(parseScript("class X\n{\n\tvoid X() { }\n\tvoid ~X() { }\n}\n")), "error"), []);
same("names that differ in case are not duplicates", codes(checkScript(parseScript("class X\n{\n\tstring GetPlaceHolderText() { }\n\tstring GetPlaceholderText() { }\n}\n")), "error"), []);
same("two methods with one signature are an error", codes(checkScript(parseScript("class X\n{\n\tvoid F(int a) { }\n\tvoid F(int a) { }\n}\n")), "error"), ["duplicate-method"]);
same("overloads by parameter type are not duplicates", codes(checkScript(parseScript("class X\n{\n\tvoid F(int a) { }\n\tvoid F(string a) { }\n}\n")), "error"), []);
same("a class inheriting from itself is an error", codes(checkScript(parseScript("class X : X\n{\n}\n")), "error"), ["self-inheritance"]);
same("an enum constant declared twice is an error", codes(checkScript(parseScript("enum E\n{\n\tA,\n\tA,\n}\n")), "error"), ["duplicate-enum-member"]);
same("a type declared twice is an error", codes(checkScript(parseScript("class X { }\nclass X { }\n")), "error"), ["duplicate-declaration"]);
same("a typedef and a class may share a name", codes(checkScript(parseScript("typedef int DateTimeUtcAsInt;\nclass DateTimeUtcAsInt { }\n")), "error"), []);
same("a duplicate inside #ifdef is a warning, not an error", codes(checkScript(parseScript("#ifdef A\nclass X { }\n#endif\n#ifdef A\nclass X { }\n#endif\n"))), ["duplicate-declaration"]);
same("a modded class next to its original is not a duplicate", codes(checkScript(parseScript("class X { }\nmodded class X { }\n")), "error"), []);
same("an enum with no constants is a note", codes(checkScript(parseScript("enum E\n{\n}\n"))), ["empty-enum"]);

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------
const cliScript = fixture("cli/Thing.c", `//! A thing.
class SCR_CliThing : Managed
{
	//! The value.
	int m_iValue;

	//! Get it.
	int GetValue() { return m_iValue; }
}

enum ECli
{
	CLI_A,
	CLI_B,
}
`);
const cliBroken = fixture("cli/Broken.c", 'class Bad { string s = "oops; }\n');

// outline
let r = runCli(["outline", cliScript]);
check("outline: exits 0", r.status === 0, r.err);
check("outline: names the declarations", r.out.includes("class SCR_CliThing") && r.out.includes("int GetValue()"), r.out);
check("outline: prints a line range per declaration", /^\s+\d+(?:-\d+)?\s+class SCR_CliThing/m.test(r.out) && /^\s+\d+(?:-\d+)?\s+method\s+int GetValue/m.test(r.out), r.out);
r = runCli(["outline", cliScript, "--json"]);
const outlineJson = r.json();
same("outline --json: an envelope, not a bare array", [outlineJson.command, outlineJson.total], ["outline", 4]);
same("outline --json: returned agrees with the array", outlineJson.returned, outlineJson.declarations.length);
same("outline --json: members are nested under their class", outlineJson.declarations.map((d) => d.depth), [0, 1, 1, 0]);

// cat: one line, an inclusive range, an open end, --plain, and the two ways a range can be wrong.
const catFile = fixture("cli/Cat.c", ["line one", "line two", "line three", "line four", "line five", ""].join("\n"));
// One root with several addon directories under it: what `--addons` is for.
const manyRoot = join(addons, "Many");
fixture("addons/Many/One/Scripts/Game/One.c", "class SCR_One\n{\n}\n");
fixture("addons/Many/Two/Scripts/Game/Two.c", "class SCR_Two\n{\n}\n");
fixture("addons/Many/Two/Scripts/Game/ModdedThing.c", "modded class SCR_Thing\n{\n\toverride void Heal(int amount)\n\t{\n\t}\n}\n");
same("splitLines does not count a final newline as a line", splitLines("a\nb\n").length, 2);
same("splitLines drops the CR of a CRLF line", splitLines("a\r\nb"), ["a", "b"]);
same("splitLines of an empty file is no lines", splitLines(""), []);
same("a single <lines> value is one line", parseLineSpec("3", 5), { from: 3, to: 3, requestedTo: 3, clamped: false });
same("a range is inclusive at both ends", parseLineSpec("2-4", 5), { from: 2, to: 4, requestedTo: 4, clamped: false });
same("an open range runs to the end of the file", parseLineSpec("4-", 5), { from: 4, to: 5, requestedTo: 5, clamped: false });
same("a range past the end is clamped and says so", parseLineSpec("4-9", 5), { from: 4, to: 5, requestedTo: 9, clamped: true });
r = runCli(["cat", catFile, "2"]);
check("cat: one line exits 0", r.status === 0, r.err);
check("cat: prints that line with its number", r.out.includes("2\tline two"), r.out);
check("cat: prints no other line", !r.out.includes("line three"), r.out);
r = runCli(["cat", catFile, "2-4"]);
check("cat: a range prints both ends", r.out.includes("2\tline two") && r.out.includes("4\tline four"), r.out);
check("cat: a range prints every line inside it", r.out.includes("3\tline three"), r.out);
check("cat: a range prints nothing outside it", !r.out.includes("line five"), r.out);
r = runCli(["cat", catFile]);
check("cat: without <lines> the whole file is printed", r.out.includes("line five") && r.out.includes("1\tline one"), r.out);
r = runCli(["cat", catFile, "5-"]);
check("cat: an open range reaches the last line", r.out.includes("5\tline five") && !r.out.includes("line four"), r.out);
r = runCli(["cat", catFile, "2-3", "--plain"]);
same("cat --plain prints the text and nothing else", r.out.split("\n").slice(1, 3), ["line two", "line three"]);
r = runCli(["cat", catFile, "2-4", "--json"]);
const catJson = r.json();
same("cat --json: an envelope naming the range", [catJson.command, catJson.from, catJson.to, catJson.fileLines], ["cat", 2, 4, 5]);
same("cat --json: every line carries its number", catJson.lines.map((l) => `${l.line}:${l.text}`), ["2:line two", "3:line three", "4:line four"]);
same("cat --json: text is the same slice", catJson.text, "line two\nline three\nline four");
same("cat --json: returned agrees with the array", [catJson.returned, catJson.lines.length], [3, 3]);
r = runCli(["cat", catFile, "4-99", "--json"]);
same("cat --json: a clamped range says so", [r.json().to, r.json().clamped, r.json().truncated], [5, true, true]);
r = runCli(["cat", catFile, "99"]);
same("cat: a line past the end exits 1", r.status, 1);
check("cat: the error names the line count", r.err.includes("5 line(s)"), r.err);
r = runCli(["cat", catFile, "4-2"]);
same("cat: a backwards range exits 1", r.status, 1);
check("cat: the error says it runs backwards", r.err.includes("backwards"), r.err);
r = runCli(["cat", catFile, "0"]);
same("cat: line 0 exits 1", r.status, 1);
r = runCli(["cat", catFile, "abc"]);
same("cat: a non-numeric <lines> exits 1", r.status, 1);
check("cat: the error shows the accepted forms", r.err.includes("400-500"), r.err);
r = runCli(["cat", catFile, "1", "--kind", "class"]);
same("cat: an option it does not take is refused", r.status, 1);
r = runCli(["cat", join(tmp, "no-such-file.c"), "1"]);
same("cat: a missing source exits 1", r.status, 1);
// A CRLF file: the range is the text, not the text plus a `\r`.
const crlfFile = fixture("cli/Crlf.c", "first\nsecond\nthird\n", { crlf: true });
r = runCli(["cat", crlfFile, "2", "--json"]);
same("cat: a CRLF file's line has no carriage return", [r.json().text, r.json().fileLines], ["second", 3]);
r = runCli(["outline", cliScript]);
same("outline: the line count of a file ending with a newline is its lines", /(\d+) line\(s\)/.exec(r.out)[1], "15");

// schema
r = runCli(["schema", cliScript, "SCR_CliThing"]);
check("schema: exits 0", r.status === 0, r.err);
check("schema: lists fields and methods", r.out.includes("fields (1)") && r.out.includes("methods (1)"), r.out);
check("schema: shows the docstring", r.out.includes("A thing."), r.out);
r = runCli(["schema", cliScript, "SCR_CliThing.GetValue", "--json"]);
const methodJson = r.json().schema;
same("schema --json: a method schema", [methodJson.kind, methodJson.name], ["method", "GetValue"]);
same("schema --json: a method names its class", [methodJson.owner.kind, methodJson.owner.name], ["class", "SCR_CliThing"]);
check("schema --json: a method has its own range", methodJson.start === 8 && methodJson.end === 8, `${methodJson.start}-${methodJson.end}`);
r = runCli(["schema", cliScript, "ECli"]);
check("schema: an enum prints its values", r.out.includes("values (2)") && r.out.includes("CLI_A") && r.out.includes("CLI_B"), r.out);
r = runCli(["schema", cliScript, "ECli", "--json"]);
same("schema --json: enum values are numbered", r.json().schema.values.map((v) => v.value), [0, 1]);
r = runCli(["schema", cliScript, "SCR_CliThing", "--members", "methods"]);
check("schema --members methods hides the fields", !r.out.includes("m_iValue   line"), r.out);

// signature
r = runCli(["signature", cliScript, "SCR_CliThing.GetValue"]);
check("signature: exits 0 and prints the signature", r.status === 0 && r.out.includes("int GetValue()"), r.out);
check("signature: prints the docstring", r.out.includes("Get it."), r.out);
r = runCli(["signature", cliScript, "SCR_CliThing", "--json"]);
same("signature --json: one definition", r.json().definitions.length, 1);
same("signature --json: the class signature", r.json().definitions[0].signature, "class SCR_CliThing : Managed");

// check
r = runCli(["check", cliScript]);
check("check: a clean file exits 0 and says so", r.status === 0 && /0 error\(s\)/.test(r.out), r.out);
r = runCli(["check", cliBroken]);
check("check: a broken file exits 1", r.status === 1, r.out + r.err);
check("check: names the problem", r.out.includes("string literal is never closed"), r.out);
r = runCli(["check", cliBroken, "--json"]);
same("check --json: ok is false and the errors are counted", [r.json().ok, r.json().errors > 0], [false, true]);
check("check --json: every problem carries a line", r.json().problems.every((p) => typeof p.line === "number"), JSON.stringify(r.json().problems));

// find-defs
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon]);
check("find-defs: exits 0 and finds the class", r.status === 0 && r.out.includes("class SCR_Thing"), r.out);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon]);
check("find-defs: reports the original and the modded copy", r.out.includes("[original]") && r.out.includes("[modded]"), r.out);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--only-modded"]);
check("find-defs --only-modded: only the modded copy", r.out.includes("[modded]") && !r.out.includes("[original]"), r.out);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--files-only"]);
same("find-defs --files-only: one source per hit", r.out.trim().split("\n").length, 2);
r = runCli(["find-defs", "SCR_Thing.Heal", "--addon", vanillaAddon, "--addon", modAddon, "--json"]);
const defs = r.json();
same("find-defs --json: an envelope with total and rows", [defs.command, defs.total, defs.definitions.length], ["find-defs", 2, 2]);
check("find-defs --json: a method hit carries its class range", defs.definitions.every((d) => d.owner && d.owner.start > 0 && d.owner.end > d.owner.start), JSON.stringify(defs.definitions.map((d) => d.owner)));
same("find-defs --json: reports the number of searched files", defs.searched.files, 3);
r = runCli(["find-defs", "NoSuchClassAnywhere", "--addon", vanillaAddon]);
same("find-defs: nothing found exits 1", r.status, 1);
r = runCli(["find-defs", "SCR_Thing"]);
same("find-defs: no source is a usage error", r.status, 1);
check("find-defs: the usage error says what to pass", r.err.includes("--pak") || r.err.includes("--addon"), r.err);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--original", "--only-modded"]);
same("--original and --only-modded cannot be combined", r.status, 1);
check("the conflict is explained", r.err.includes("cannot be combined"), r.err);

// --addons: one root, every directory under it is an addon.
r = runCli(["find-defs", "SCR_One", "--addons", manyRoot]);
check("--addons finds a class in the first addon under the root", r.status === 0 && r.out.includes("class SCR_One"), r.out);
r = runCli(["find-defs", "SCR_Two", "--addons", manyRoot]);
check("--addons finds a class in the second addon under the root", r.status === 0 && r.out.includes("class SCR_Two"), r.out);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addons", manyRoot, "--only-modded"]);
check("--addons finds a modded copy and names the addon it came from", r.out.includes("[Two]"), r.out);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addons", manyRoot, "--compact"]);
const manyDefs = r.json();
same("--addons: each copy carries its addon in the source table", manyDefs.sourceTable.map((s) => s.addon).filter(Boolean).sort(), ["Two", "Vanilla"]);
r = runCli(["check", "--addons", manyRoot, "--json"]);
same("--addons: check reads the addon directories under the root", [r.json().files, r.json().errors], [3, 0]);
r = runCli(["find-defs", "SCR_One", "--addon", join(manyRoot, "One"), "--addons", manyRoot, "--json"]);
same("--addons and --addon do not double a source", r.json().total, 1);
r = runCli(["find-defs", "SCR_One", "--addons", join(tmp, "no-addons-here")]);
same("--addons on a missing root exits 1", r.status, 1);
const emptyRoot = fixture("addons/Empty/README.txt", "no scripts here\n");
r = runCli(["find-defs", "SCR_One", "--addons", join(addons, "Empty")]);
same("--addons on a root without scripts exits 1", r.status, 1);
check("the error says it looks one level down", r.err.includes("one level down"), r.err);
r = runCli(["find-defs", "SCR_One", "--addons", emptyRoot]);
same("--addons on a file exits 1", r.status, 1);

// --compact: one source table instead of a source object per row, and no empty fields.
const verboseDefs = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--json"]).json();
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--compact"]);
const compactDefs = r.json();
check("--compact implies --json", r.status === 0 && compactDefs.command === "find-defs", r.out);
same("--compact marks the envelope", compactDefs.compact, true);
same(
  "--compact: the rows are the same rows",
  compactDefs.definitions.map((d) => d.qualifiedName),
  verboseDefs.definitions.map((d) => d.qualifiedName),
);
check(
  "--compact: every row's source is an id inside the table",
  compactDefs.definitions.every((d) => Number.isInteger(d.source) && d.source >= 0 && d.source < compactDefs.sourceTable.length),
  JSON.stringify(compactDefs.definitions.map((d) => d.source)),
);
same(
  "--compact: the table names the file the verbose row named",
  compactDefs.sourceTable[compactDefs.definitions[0].source].display,
  verboseDefs.definitions[0].source.display,
);
check(
  "--compact: a false flag is left out, a true one stays",
  !Object.hasOwn(verboseDefs.definitions[0], "modded") ||
    (!Object.hasOwn(compactDefs.definitions[0], "modded") && compactDefs.definitions.some((d) => d.modded === true)),
  JSON.stringify(compactDefs.definitions.map((d) => d.modded)),
);
check(
  "--compact: an empty array is left out",
  !Object.hasOwn(compactDefs.definitions[0], "conditions") && !Object.hasOwn(compactDefs.definitions[0], "attrs"),
  Object.keys(compactDefs.definitions[0]).join(","),
);
check(
  "--compact: a field the verbose row had as null is kept",
  ["doc", "banner", "group"].every((key) => Object.hasOwn(compactDefs.definitions[0], key)),
  Object.keys(compactDefs.definitions[0]).join(","),
);
r = runCli(["find-defs", "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--compact", "--json"]);
same("--compact and --json together are not a conflict", r.status, 0);
r = runCli(["cat", catFile, "2", "--compact"]);
same("--compact works for a single-source command", [r.json().command, typeof r.json().source, r.json().sourceTable.length], ["cat", "number", 1]);
const blankFile = fixture("cli/Blank.c", "one\n\ntwo\n");
r = runCli(["cat", blankFile, "2", "--compact"]);
same("--compact: an empty line keeps its empty text", [r.json().lines[0].line, r.json().lines[0].text], [2, ""]);

// inheritance-chain
r = runCli(["inheritance-chain", basePath, "SCR_Child", "--addon", vanillaAddon]);
check("inheritance-chain: exits 0", r.status === 0, r.err);
check("inheritance-chain: lists the class and its base", r.out.includes("class SCR_Child : SCR_Thing") && r.out.includes("class SCR_Thing : SCR_Root"), r.out);
r = runCli(["inheritance-chain", basePath, "SCR_Child", "--addon", vanillaAddon, "--json"]);
const chainJson = r.json();
same("inheritance-chain --json: three steps", chainJson.chain.map((s) => s.name), ["SCR_Child", "SCR_Thing", "SCR_Root"]);
same("inheritance-chain --json: depths", chainJson.chain.map((s) => s.depth), [0, 1, 2]);
r = runCli(["inheritance-chain", basePath, "SCR_Child", "--addon", vanillaAddon, "--depth", "1"]);
check("inheritance-chain --depth stops and says so", r.out.includes("raise --depth"), r.out);
r = runCli(["inheritance-chain", basePath, "NoSuchClass", "--addon", vanillaAddon]);
same("inheritance-chain: an unknown class exits 1", r.status, 1);
const moddedPath = join(modAddon, "Scripts", "Game", "BaseModded.c");
r = runCli(["inheritance-chain", moddedPath, "--addon", vanillaAddon, "--addon", modAddon, "--json"]);
same("inheritance-chain: a modded class's chain starts with the original it replaces", r.json().chain.map((s) => `${s.role}:${s.modded}`), ["root:true", "original:false", "ancestor:false"]);

// subclass-tree
r = runCli(["subclass-tree", basePath, "SCR_Thing", "--addon", vanillaAddon]);
check("subclass-tree: exits 0", r.status === 0, r.err);
check("subclass-tree: the child is indented under the root", /^SCR_Thing/m.test(r.out) && /^\s+SCR_Child/m.test(r.out), r.out);
r = runCli(["subclass-tree", basePath, "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--json"]);
const treeJson = r.json();
same("subclass-tree --json: the root is the class", treeJson.tree.name, "SCR_Thing");
same("subclass-tree --json: the modded copy is listed on the root", treeJson.tree.declarations.length, 2);
same("subclass-tree --json: the tree is nested", treeJson.tree.children[0].children[0].name, "SCR_GrandChild");
r = runCli(["subclass-tree", basePath, "SCR_Thing", "--addon", vanillaAddon, "--addon", modAddon, "--no-modded", "--json"]);
same("subclass-tree --no-modded leaves the modded copies out", r.json().tree.declarations.length, 1);

// Options are checked per command, and a bad value is a usage error.
r = runCli(["signature", cliScript, "SCR_CliThing", "--depth", "2"]);
same("an option the command does not take is a usage error", r.status, 1);
check("the usage error names the option", r.err.includes("--depth"), r.err);
r = runCli(["outline", cliScript, "--kind", "class"]);
same("another command's option is refused too", r.status, 1);
r = runCli(["find-defs", "X", "--addon", vanillaAddon, "--kind", "nonsense"]);
same("an unknown --kind is a usage error", r.status, 1);
r = runCli(["outline", join(tmp, "no-such-file.c")]);
same("a missing source exits 1", r.status, 1);
r = runCli(["nonsense"]);
same("an unknown command exits 1", r.status, 1);
r = runCli(["--help"]);
same("--help prints the usage and exits 0", r.status, 0);

// ---------------------------------------------------------------------------
// Library helpers the CLI stands on
// ---------------------------------------------------------------------------
same("an addon directory is found from a file inside it", enclosingAddon(join(vanillaAddon, "Scripts", "Game", "Base.c")), vanillaAddon);
same("scriptFilesUnder finds the scripts", scriptFilesUnder(join(addons, "Vanilla")).length, 1);
same("pakFilesUnder on a directory with no archives is empty", pakFilesUnder(join(addons, "Vanilla")).length, 0);
same("a <pak>:<entry> spec is split for the reader", parseSourceSpec("C:/x/data.pak:scripts/A.c").kind, "pak");
same("a Windows path is not a pak spec", parseSourceSpec("C:/x/A.c").kind, "file");
same("the one extension this reader accepts", EXTENSIONS, [".c"]);

// The row every command prints is built in one place, so its shape is pinned here.
const row = definitionRow(decl(script, "GetAnswer"), { kind: "file", display: "Weapons.c", path: "Weapons.c", addon: "test" });
same(
  "a definition row carries what find-defs promises",
  ["kind", "name", "qualifiedName", "modded", "signature", "start", "end", "doc", "attrs", "owner"].map((key) => row[key] !== undefined && row[key] !== null),
  [true, true, true, true, true, true, true, true, true, true],
);
same("declarationsOf flattens a file: 8 top-level types and their members", declarationsOf(script).filter((d) => !d.owner).length, 8);
check("declarationsOf includes members and enum constants", declarationsOf(script).length > 8);

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL TESTS PASSED");
if (failures) process.exitCode = 1;
