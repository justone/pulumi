// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as grpc from "grpc";
import * as log from "../log";
import { CustomResourceOptions, ID, Input, Inputs, Output, Resource, ResourceOptions, URN } from "../resource";
import { debuggablePromise, errorString } from "./debuggable";
import {
    deserializeProperties,
    deserializeProperty,
    OutputResolvers,
    resolveProperties,
    serializeProperties,
    serializeProperty,
    serializeResourceProperties,
    transferProperties,
    unknownValue,
} from "./rpc";
import { excessiveDebugOutput, getMonitor, rpcKeepAlive, serialize } from "./settings";

const gstruct = require("google-protobuf/google/protobuf/struct_pb.js");
const resproto = require("../proto/resource_pb.js");

interface ResourceResolverOperation {
    // A resolver for a resource's URN.
    resolveURN: (urn: URN) => void;
    // A resolver for a resource's ID (for custom resources only).
    resolveID: ((v: ID, performApply: boolean) => void) | undefined;
    // A collection of resolvers for a resource's properties.
    resolvers: OutputResolvers;
    // A parent URN, fully resolved, if any.
    parentURN: URN | undefined;
    // A provider reference, fully resolved, if any.
    providerRef: string | undefined;
    // All serialized properties, fully awaited, serialized, and ready to go.
    serializedProps: Record<string, any>;
    // A set of dependency URNs that this resource is dependent upon (both implicitly and explicitly).
    dependencies: Set<URN>;
}

/**
 * Reads an existing custom resource's state from the resource monitor.  Note that resources read in this way
 * will not be part of the resulting stack's state, as they are presumed to belong to another.
 */
export function readResource(res: Resource, t: string, name: string, props: Inputs, opts: ResourceOptions): void {
    const id: Input<ID> | undefined = opts.id;
    if (!id) {
        throw new Error("Cannot read resource whose options are lacking an ID value");
    }

    const label = `resource:${name}[${t}]#...`;
    log.debug(`Reading resource: id=${id}, t=${t}, name=${name}`);

    const monitor: any = getMonitor();
    const resopAsync = prepareResource(label, res, true, props, opts);
    const preallocError = new Error();
    debuggablePromise(resopAsync.then(async (resop) => {
        const resolvedID = await serializeProperty(label, id, []);
        log.debug(`ReadResource RPC prepared: id=${resolvedID}, t=${t}, name=${name}` +
            (excessiveDebugOutput ? `, obj=${JSON.stringify(resop.serializedProps)}` : ``));

        // Create a resource request and do the RPC.
        const req = new resproto.ReadResourceRequest();
        req.setType(t);
        req.setName(name);
        req.setId(resolvedID);
        req.setParent(resop.parentURN);
        req.setProvider(resop.providerRef);
        req.setProperties(gstruct.Struct.fromJavaScript(resop.serializedProps));
        req.setDependenciesList(Array.from(resop.dependencies));

        // Now run the operation, serializing the invocation if necessary.
        const opLabel = `monitor.readResource(${label})`;
        runAsyncResourceOp(opLabel, async () => {
            const resp: any = await debuggablePromise(new Promise((resolve, reject) =>
                monitor.readResource(req, (err: Error, innerResponse: any) => {
                    log.debug(`ReadResource RPC finished: ${label}; err: ${err}, resp: ${innerResponse}`);
                    if (err) {
                        preallocError.message =
                            `failed to read resource #${resolvedID} '${name}' [${t}]: ${err.message}`;
                        reject(preallocError);
                    }
                    else {
                        resolve(innerResponse);
                    }
                })), opLabel);

            // Now resolve everything: the URN, the ID (supplied as input), and the output properties.
            resop.resolveURN(resp.getUrn());
            resop.resolveID!(resolvedID, resolvedID !== undefined);
            await resolveOutputs(res, t, name, props, resp.getProperties(), resop.resolvers);
        });
    }));
}

/**
 * registerResource registers a new resource object with a given type t and name.  It returns the auto-generated
 * URN and the ID that will resolve after the deployment has completed.  All properties will be initialized to property
 * objects that the registration operation will resolve at the right time (or remain unresolved for deployments).
 */
export function registerResource(res: Resource, t: string, name: string, custom: boolean,
                                 props: Inputs, opts: ResourceOptions): void {
    const label = `resource:${name}[${t}]`;
    log.debug(`Registering resource: t=${t}, name=${name}, custom=${custom}`);

    const monitor: any = getMonitor();
    const resopAsync = prepareResource(label, res, custom, props, opts);

    // In order to present a useful stack trace if an error does occur, we preallocate potential
    // errors here. V8 captures a stack trace at the moment an Error is created and this stack
    // trace will lead directly to user code. Throwing in `runAsyncResourceOp` results in an Error
    // with a non-useful stack trace.
    const preallocError = new Error();
    debuggablePromise(resopAsync.then(async (resop) => {
        log.debug(`RegisterResource RPC prepared: t=${t}, name=${name}` +
            (excessiveDebugOutput ? `, obj=${JSON.stringify(resop.serializedProps)}` : ``));

        const req = new resproto.RegisterResourceRequest();
        req.setType(t);
        req.setName(name);
        req.setParent(resop.parentURN);
        req.setCustom(custom);
        req.setObject(gstruct.Struct.fromJavaScript(resop.serializedProps));
        req.setProtect(opts.protect);
        req.setProvider(resop.providerRef);
        req.setDependenciesList(Array.from(resop.dependencies));

        // Now run the operation, serializing the invocation if necessary.
        const opLabel = `monitor.registerResource(${label})`;
        runAsyncResourceOp(opLabel, async () => {
            const resp: any = await debuggablePromise(new Promise((resolve, reject) =>
                monitor.registerResource(req, (err: grpc.ServiceError, innerResponse: any) => {
                    log.debug(`RegisterResource RPC finished: ${label}; err: ${err}, resp: ${innerResponse}`);
                    if (err) {
                        // If the monitor is unavailable, it is in the process of shutting down or has already
                        // shut down. Don't emit an error and don't do any more RPCs.
                        if (err.code === grpc.status.UNAVAILABLE) {
                            log.debug("Resource monitor is terminating");
                            waitForDeath();
                        }

                        // Node lets us hack the message as long as we do it before accessing the `stack` property.
                        preallocError.message = `failed to register new resource ${name} [${t}]: ${err.message}`;
                        reject(preallocError);
                    }
                    else {
                        resolve(innerResponse);
                    }
                })), opLabel);

            resop.resolveURN(resp.getUrn());

            // Note: 'id || undefined' is intentional.  We intentionally collapse falsy values to
            // undefined so that later parts of our system don't have to deal with values like 'null'.
            if (resop.resolveID) {
                const id = resp.getId() || undefined;
                resop.resolveID(id, id !== undefined);
            }

            // Now resolve the output properties.
            await resolveOutputs(res, t, name, props, resp.getObject(), resop.resolvers);
        });
    }));
}

/**
 * Prepares for an RPC that will manufacture a resource, and hence deals with input and output properties.
 */
async function prepareResource(label: string, res: Resource, custom: boolean,
                               props: Inputs, opts: ResourceOptions): Promise<ResourceResolverOperation> {
    // Simply initialize the URN property and get prepared to resolve it later on.
    // Note: a resource urn will always get a value, and thus the output property
    // for it can always run .apply calls.
    let resolveURN: (urn: URN) => void;
    (res as any).urn = Output.create(
        res,
        debuggablePromise(
            new Promise<URN>(resolve => resolveURN = resolve),
            `resolveURN(${label})`),
        /*performApply:*/ Promise.resolve(true));

    // If a custom resource, make room for the ID property.
    let resolveID: ((v: any, performApply: boolean) => void) | undefined;
    if (custom) {
        let resolveValue: (v: ID) => void;
        let resolvePerformApply: (v: boolean) => void;
        (res as any).id = Output.create(
            res,
            debuggablePromise(new Promise<ID>(resolve => resolveValue = resolve), `resolveID(${label})`),
            debuggablePromise(new Promise<boolean>(
                resolve => resolvePerformApply = resolve), `resolveIDPerformApply(${label})`));

        resolveID = (v, performApply) => {
            resolveValue(v);
            resolvePerformApply(performApply);
        };
    }

    // Now "transfer" all input properties into unresolved Promises on res.  This way,
    // this resource will look like it has all its output properties to anyone it is
    // passed to.  However, those promises won't actually resolve until the registerResource
    // RPC returns
    const resolvers = transferProperties(res, label, props);

    /** IMPORTANT!  We should never await prior to this line, otherwise the Resource will be partly uninitialized. */

    // Before we can proceed, all our dependencies must be finished.
    let dependsOn: Resource[] = [];
    if (Array.isArray(opts.dependsOn)) {
        dependsOn = opts.dependsOn;
    } else if (opts.dependsOn) {
        dependsOn = [opts.dependsOn];
    }
    const explicitURNDeps = await debuggablePromise(
        Promise.all(dependsOn.map(d => d.urn.promise())), `dependsOn(${label})`);

    // Serialize out all our props to their final values.  In doing so, we'll also collect all
    // the Resources pointed to by any Dependency objects we encounter, adding them to 'propertyDependencies'.
    const implicitDependencies: Resource[] = [];
    const serializedProps = await serializeResourceProperties(label, props, implicitDependencies);

    let parentURN: URN | undefined;
    if (opts.parent) {
        parentURN = await opts.parent.urn.promise();
    }

    let providerRef: string | undefined;
    if (custom && (<CustomResourceOptions>opts).provider) {
        const provider = (<CustomResourceOptions>opts).provider!;
        const providerURN = await provider.urn.promise();
        const providerID = await provider.id.promise() || unknownValue;
        providerRef = `${providerURN}::${providerID}`;
    }

    const dependencies: Set<URN> = new Set<URN>(explicitURNDeps);
    for (const implicitDep of implicitDependencies) {
        dependencies.add(await implicitDep.urn.promise());
    }

    return {
        resolveURN: resolveURN!,
        resolveID: resolveID,
        resolvers: resolvers,
        serializedProps: serializedProps,
        parentURN: parentURN,
        providerRef: providerRef,
        dependencies: dependencies,
    };
}

/**
 * Finishes a resource creation RPC operation by resolving its outputs to the resulting RPC payload.
 */
async function resolveOutputs(res: Resource, t: string, name: string,
                              props: Inputs, outputs: any, resolvers: OutputResolvers): Promise<void> {
    // Produce a combined set of property states, starting with inputs and then applying
    // outputs.  If the same property exists in the inputs and outputs states, the output wins.
    const allProps: Record<string, any> = {};
    if (outputs) {
        Object.assign(allProps, deserializeProperties(outputs));
    }

    const label = `resource:${name}[${t}]#...`;
    for (const key of Object.keys(props)) {
        if (!allProps.hasOwnProperty(key)) {
            // input prop the engine didn't give us a final value for.  Just use the value passed into the resource
            // after round-tripping it through serialization. We do the round-tripping primarily s.t. we ensure that
            // Output values are handled properly w.r.t. unknowns.
            const inputProp = await serializeProperty(label, props[key], []);
            if (inputProp === undefined) {
                continue;
            }
            allProps[key] = deserializeProperty(inputProp);
        }
    }

    resolveProperties(res, resolvers, t, name, allProps);
}

/**
 * registerResourceOutputs completes the resource registration, attaching an optional set of computed outputs.
 */
export function registerResourceOutputs(res: Resource, outputs: Inputs | Promise<Inputs> | Output<Inputs>) {
    // Now run the operation. Note that we explicitly do not serialize output registration with
    // respect to other resource operations, as outputs may depend on properties of other resources
    // that will not resolve until later turns. This would create a circular promise chain that can
    // never resolve.
    const opLabel = `monitor.registerResourceOutputs(...)`;
    runAsyncResourceOp(opLabel, async () => {
        // The registration could very well still be taking place, so we will need to wait for its URN.
        // Additionally, the output properties might have come from other resources, so we must await those too.
        const urn = await res.urn.promise();
        const resolved = await serializeProperties(opLabel, { outputs });
        const outputsObj = gstruct.Struct.fromJavaScript(resolved.outputs);
        log.debug(`RegisterResourceOutputs RPC prepared: urn=${urn}` +
            (excessiveDebugOutput ? `, outputs=${JSON.stringify(outputsObj)}` : ``));

        // Fetch the monitor and make an RPC request.
        const monitor: any = getMonitor();

        const req = new resproto.RegisterResourceOutputsRequest();
        req.setUrn(urn);
        req.setOutputs(outputsObj);

        await debuggablePromise(new Promise((resolve, reject) =>
            monitor.registerResourceOutputs(req, (err: grpc.ServiceError, innerResponse: any) => {
                log.debug(`RegisterResourceOutputs RPC finished: urn=${urn}; `+
                    `err: ${err}, resp: ${innerResponse}`);
                if (err) {
                    // If the monitor is unavailable, it is in the process of shutting down or has already
                    // shut down. Don't emit an error and don't do any more RPCs.
                    if (err.code === grpc.status.UNAVAILABLE) {
                        log.debug("Resource monitor is terminating");
                        waitForDeath();
                    }

                    log.error(`Failed to end new resource registration '${urn}': ${err.stack}`);
                    reject(err);
                }
                else {
                    resolve();
                }
            })), opLabel);
    }, false);
}

/**
 * resourceChain is used to serialize all resource requests.  If we don't do this, all resource operations will be
 * entirely asynchronous, meaning the dataflow graph that results will determine ordering of operations.  This
 * causes problems with some resource providers, so for now we will serialize all of them.  The issue
 * pulumi/pulumi#335 tracks coming up with a long-term solution here.
 */
let resourceChain: Promise<void> = Promise.resolve();
let resourceChainLabel: string | undefined = undefined;

// runAsyncResourceOp runs an asynchronous resource operation, possibly serializing it as necessary.
function runAsyncResourceOp(label: string, callback: () => Promise<void>, serial?: boolean): void {
    // Serialize the invocation if necessary.
    if (serial === undefined) {
        serial = serialize();
    }
    const resourceOp: Promise<void> = debuggablePromise(resourceChain.then(async () => {
        if (serial) {
            resourceChainLabel = label;
            log.debug(`Resource RPC serialization requested: ${label} is current`);
        }
        return callback();
    }));

    // Ensure the process won't exit until this RPC call finishes and resolve it when appropriate.
    const done: () => void = rpcKeepAlive();
    const finalOp: Promise<void> = debuggablePromise(resourceOp.then(() => { done(); }, () => { done(); }));

    // Set up another promise that propagates the error, if any, so that it triggers unhandled rejection logic.
    resourceOp.catch((err) => Promise.reject(err));

    // If serialization is requested, wait for the prior resource operation to finish before we proceed, serializing
    // them, and make this the current resource operation so that everybody piles up on it.
    if (serial) {
        resourceChain = finalOp;
        if (resourceChainLabel) {
            log.debug(`Resource RPC serialization requested: ${label} is behind ${resourceChainLabel}`);
        }
    }
}

/**
 * waitForDeath loops forever. This is a hack.
 *
 * The purpose of this hack is to deal with graceful termination of the resource monitor.
 * When the engine decides that it needs to terminate, it shuts down the Log and ResourceMonitor RPC
 * endpoints. Shutting down RPC endpoints involves draining all outstanding RPCs and denying new connections.
 *
 * This is all fine for us as the language host, but we need to 1) not let the RPC that just failed due to
 * the ResourceMonitor server shutdown get displayed as an error and 2) not do any more RPCs, since they'll fail.
 *
 * We can accomplish both by just doing nothing until the engine kills us. It's ugly, but it works.
 */
function waitForDeath(): never {
    // tslint:disable-next-line
    while (true) {}
}
