// Package plugintest assembles WebAssembly guests for tests that have to run
// a real one outside package plugin, where the hostile fixtures live.
//
// Nothing here is checked in as a binary, for the reason those fixtures give:
// a committed .wasm goes stale silently. It is imported by tests only.
package plugintest

import (
	"github.com/tetratelabs/wabin/binary"
	"github.com/tetratelabs/wabin/leb128"
	"github.com/tetratelabs/wabin/wasm"
)

// CounterKey is the store key the Counter guest's value lives under: the key
// "n" in the unnamed scope. A test seeds it with CounterSeed before the
// guest's first action.
const CounterKey = "\x1fn"

// CounterSeed is the value a test stores under CounterKey first. Every action
// appends three more bytes, so (len-3)/3 is how many actions were kept.
var CounterSeed = []byte("AAA")

const (
	opLoop     = 0x03
	opBlock    = 0x02
	opEnd      = 0x0b
	opBr       = 0x0c
	opBrIf     = 0x0d
	opCall     = 0x10
	opDrop     = 0x1a
	opLocalGet = 0x20
	opLocalSet = 0x21
	opLocalTee = 0x22
	opI32Const = 0x41
	opI64Const = 0x42
	opI64GeU   = 0x5a
	opI32Sub   = 0x6b
	opI64Add   = 0x7c
	opI64Sub   = 0x7d

	blockEmpty = 0x40
)

func i32Const(v int32) []byte { return append([]byte{opI32Const}, leb128.EncodeInt32(v)...) }
func i64Const(v int) []byte   { return append([]byte{opI64Const}, leb128.EncodeInt64(int64(v))...) }

// storeBytes writes s into Extism memory at the offset held in a local, one
// byte at a time: a guest's own data segment is not memory the host can read.
func storeBytes(storeU8 uint32, local byte, s string) []byte {
	var out []byte
	for i := range len(s) {
		out = append(out, opLocalGet, local)
		out = append(out, i64Const(i)...)
		out = append(out, opI64Add)
		out = append(out, i32Const(int32(s[i]))...)
		out = append(out, opCall, byte(storeU8))
	}
	return out
}

func join(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// Counter is the shape every ceremony has. Its on_session_action reads a
// document from the key-value store, changes it and writes it back: it
// appends three bytes to the value under "n", and spins between the read and
// the write so two calls that are allowed to overlap do overlap. Its
// on_session_state returns the stored value, as kv_get answered it.
//
// It never parses: the stored value comes back as base64 inside a response of
// a fixed shape, three bytes are four base64 characters, so the new value is
// the old one's characters with four more on the end. The value has to exist
// already, which is what CounterSeed is for.
func Counter() []byte {
	const (
		getReq   = `{"key":"n"}`
		respHead = `{"ok":true,"data":{"found":true,"value":"`
		respTail = `"}}`
		setHead  = `{"key":"n","value":"`
		setTail  = `QUFB"}`

		req, resp, n, out, i, spin = 0, 1, 2, 3, 4, 5
	)
	i64, i32 := wasm.ValueTypeI64, wasm.ValueTypeI32
	var types []*wasm.FunctionType
	var imports []*wasm.Import
	imp := func(module, name string, params, results []wasm.ValueType) byte {
		types = append(types, &wasm.FunctionType{Params: params, Results: results})
		imports = append(imports, &wasm.Import{
			Type: wasm.ExternTypeFunc, Module: module, Name: name, DescFunc: uint32(len(types) - 1),
		})
		return byte(len(imports) - 1)
	}
	alloc := imp("extism:host/env", "alloc", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	length := imp("extism:host/env", "length", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	loadU8 := imp("extism:host/env", "load_u8", []wasm.ValueType{i64}, []wasm.ValueType{i32})
	storeU8 := imp("extism:host/env", "store_u8", []wasm.ValueType{i64, i32}, nil)
	outputSet := imp("extism:host/env", "output_set", []wasm.ValueType{i64, i64}, nil)
	kvGet := imp("extism:host/user", "parley_kv_get", []wasm.ValueType{i64}, []wasm.ValueType{i64})
	kvSet := imp("extism:host/user", "parley_kv_set", []wasm.ValueType{i64}, []wasm.ValueType{i64})

	// resp = kv_get(getReq)
	read := join(i64Const(len(getReq)), []byte{opCall, alloc, opLocalSet, req},
		storeBytes(uint32(storeU8), req, getReq),
		[]byte{opLocalGet, req, opCall, kvGet, opLocalSet, resp})

	action := join(read,
		// n = length(resp) - the fixed wrapping
		[]byte{opLocalGet, resp, opCall, length}, i64Const(len(respHead)+len(respTail)),
		[]byte{opI64Sub, opLocalSet, n},
		// The window a second writer falls into.
		i32Const(300_000), []byte{opLocalSet, spin, opLoop, blockEmpty, opLocalGet, spin},
		i32Const(1), []byte{opI32Sub, opLocalTee, spin, opBrIf, 0, opEnd},
		// out = setHead + resp[len(respHead):][:n] + setTail
		[]byte{opLocalGet, n}, i64Const(len(setHead)+len(setTail)),
		[]byte{opI64Add, opCall, alloc, opLocalSet, out},
		storeBytes(uint32(storeU8), out, setHead),
		[]byte{opBlock, blockEmpty, opLoop, blockEmpty,
			opLocalGet, i, opLocalGet, n, opI64GeU, opBrIf, 1,
			opLocalGet, out}, i64Const(len(setHead)), []byte{opI64Add, opLocalGet, i, opI64Add,
			opLocalGet, resp}, i64Const(len(respHead)), []byte{opI64Add, opLocalGet, i, opI64Add,
			opCall, loadU8, opCall, storeU8,
			opLocalGet, i}, i64Const(1), []byte{opI64Add, opLocalSet, i,
			opBr, 0, opEnd, opEnd},
		[]byte{opLocalGet, out}, i64Const(len(setHead)), []byte{opI64Add, opLocalGet, n, opI64Add, opLocalSet, req},
		storeBytes(uint32(storeU8), req, setTail),
		[]byte{opLocalGet, out, opCall, kvSet, opDrop},
		i32Const(0), []byte{opEnd})

	state := join(read,
		[]byte{opLocalGet, resp, opLocalGet, resp, opCall, length, opCall, outputSet},
		i32Const(0), []byte{opEnd})

	types = append(types, &wasm.FunctionType{Results: []wasm.ValueType{i32}})
	fn := uint32(len(types) - 1)
	first := uint32(len(imports))
	return binary.EncodeModule(&wasm.Module{
		TypeSection:     types,
		ImportSection:   imports,
		FunctionSection: []wasm.Index{fn, fn},
		ExportSection: []*wasm.Export{
			{Type: wasm.ExternTypeFunc, Name: "on_session_action", Index: first},
			{Type: wasm.ExternTypeFunc, Name: "on_session_state", Index: first + 1},
		},
		CodeSection: []*wasm.Code{
			{LocalTypes: []wasm.ValueType{i64, i64, i64, i64, i64, i32}, Body: action},
			{LocalTypes: []wasm.ValueType{i64, i64}, Body: state},
		},
	})
}
