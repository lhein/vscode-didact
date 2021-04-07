/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as vscode from 'vscode';
import * as utils from './utils';
import * as extensionFunctions from './extensionFunctions';
import * as path from 'path';
import { isAsciiDoc } from './extensionFunctions';
import { HTMLElement } from 'node-html-parser';

export class DidactNodeProvider implements vscode.TreeDataProvider<SimpleNode> {

	private _onDidChangeTreeData: vscode.EventEmitter<SimpleNode | undefined> = new vscode.EventEmitter<SimpleNode | undefined>();
	readonly onDidChangeTreeData: vscode.Event<SimpleNode | undefined> = this._onDidChangeTreeData.event;

	protected treeNodes: TreeNode[] = [];
	protected retrieveTutorials = true;

	// clear the tree
	public resetList(): void {
		this.treeNodes = [];
	}

	// set up so we don't pollute test runs with registered tutorials
	public setRetrieveIntegrations(flag:boolean): void {
		this.retrieveTutorials = flag;
	}

	// get the list of children for the node provider
	public async getChildren(element?: SimpleNode): Promise<SimpleNode[]> {
		if (!element) {
			return this.treeNodes;
		} else if (element instanceof TutorialNode) {
			return await this.processHeadingsForTutorial(element.uri, element.category);
		} else {
			// assume it's a category
			if (element.label && !(element instanceof TutorialNode)) {
				const tutorialCategory = retrieveTreeItemName(element);
				return await this.processTutorialsForCategory(tutorialCategory);
			}   
		}
		return [];
	}

	// add a child to the list of nodes
	public addChild(newNode: SimpleNode, disableRefresh = false, oldNodes: SimpleNode[] = this.treeNodes ): SimpleNode[] {
		if (oldNodes) {
			oldNodes.push(newNode);
			if (!disableRefresh) {
				this.refresh();
			}
		}
		return oldNodes;		
	}

	// This method isn't used by the view currently, but is here to facilitate testing
	public removeChild(oldNode: SimpleNode, disableRefresh = false, oldNodes: SimpleNode[] = this.treeNodes ): SimpleNode[] {
		if (oldNodes) {
			const index = oldNodes.indexOf(oldNode);
			if (index !== -1) {
				oldNodes.splice(index, 1);
				if (!disableRefresh) {
					this.refresh();
				}
			}
		}
		return oldNodes;
	}

	// trigger a refresh event in VSCode
	public refresh(): void {
		this.resetList();
		if (this.retrieveTutorials) {
			this.processRegisteredTutorials();
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	public async getParent(element : SimpleNode) : Promise<SimpleNode | null> {
		if (element instanceof TutorialNode) {
			const tutorial = element as TutorialNode;
			if (tutorial.category) {
				return this.findCategoryNode(tutorial.category);
			}
		}
		if (element instanceof HeadingNode) {
			const heading = element as HeadingNode;
			if (heading.category && heading.uri) {
				return await this.findHeadingNode(heading.category, heading.uri);
			}
		}
		// Return null if element is a category and a child of root
		return null;
	}

	getTreeItem(node: SimpleNode): vscode.TreeItem {
		return node;
	}

	doesNodeExist(oldNodes: SimpleNode[], newNode: SimpleNode): boolean {
		for (const node of oldNodes) {
			if (node.label === newNode.label) {
				return true;
			}
		}
		return false;
	}

	// process the list of registered tutorials 
	processRegisteredTutorials(): void {
		const categories : string[] | undefined = utils.getDidactCategories();
		if (categories) {
			for (const category of categories) {
				const newNode = new TreeNode(category, category, undefined, vscode.TreeItemCollapsibleState.Collapsed);
				if (!this.doesNodeExist(this.treeNodes, newNode)) {
					this.addChild(newNode, true, this.treeNodes);
				}
			}
		}
	}

	async processTutorialsForCategory(category: string | undefined) : Promise<SimpleNode[]> {
		const children : SimpleNode[] = [];
		if (category) {
			const tutorials : string[] | undefined = utils.getTutorialsForCategory(category);
			if (tutorials) {
				for (const tutorial of tutorials) {
					let hasChildren = vscode.TreeItemCollapsibleState.None;
					const tutUri : string | undefined = utils.getUriForDidactNameAndCategory(tutorial, category);
					let timeLabel : string | undefined = undefined;
					if (tutUri) {
						const timeCount = await extensionFunctions.computeTimeForDidactFileUri(vscode.Uri.parse(tutUri));
						if (timeCount > 0) {
							timeLabel = `(~${timeCount} mins)`;
							hasChildren = vscode.TreeItemCollapsibleState.Collapsed;
						}
					}
			
					const newNode = new TutorialNode(category, tutorial, tutUri, hasChildren, timeLabel);
					newNode.contextValue = 'TutorialNode';
					if (!this.doesNodeExist(children, newNode)) {
						this.addChild(newNode, true, children);
					}
				}
			}
		}
		return children;
	}

	getNodeFromADOCDiv(divElement : HTMLElement, tutUri: string | undefined, category : string | undefined) : HeadingNode | undefined {
		const classAttr : string | undefined = divElement.getAttribute("class");
		if (classAttr) {
			const splitArray : string[] = classAttr.split(' ');
			for (let count = 0; count < splitArray.length; count++) {
				const chunk = splitArray[count];
				if (chunk.startsWith('time=')) {
					const splitTime = chunk.split('=')[1];
					const timeValue = Number(splitTime);
					if (divElement.childNodes.length > 0) {
						const children = divElement.childNodes;
						for (let i = 0; i < children.length; i++) {
							if (children[i] instanceof HTMLElement) {
								const child = children[i] as HTMLElement;
								if (child.tagName.startsWith('H')) {
									const title = children[i].innerText;
									if (!Number.isNaN(timeValue)) {
										return new HeadingNode(category, title, tutUri, `(~${timeValue} mins)`);
									} else {
										extensionFunctions.sendTextToOutputChannel(`Warning: Heading node "${title}" has an invalid time value set to "${splitTime}"`)
									}
								}
							}
						}
					}
				}
			}
		}
		return undefined;
	}

	async processHeadingsForTutorial(tutUri: string | undefined, category : string | undefined) : Promise<HeadingNode[]> {
		const children : HeadingNode[] = [];
		if (tutUri) {
			const headings : HTMLElement[] | undefined = await extensionFunctions.getTimeElementsForDidactFileUri(vscode.Uri.parse(tutUri));
			if (headings && !isAsciiDoc(tutUri)) {
				for (const heading of headings) {
					const timeAttr = heading.getAttribute("time");

					let timeLabel = undefined;
					const timeValue = Number(timeAttr);
					if (!Number.isNaN(timeValue)) {
						timeLabel = `(~${timeValue} mins)`;
					}
					const title = heading.rawText;
					const newNode = new HeadingNode(category, title, tutUri, timeLabel);
					newNode.contextValue = 'HeadingNode';
					if (!this.doesNodeExist(children, newNode) && timeLabel) {
						this.addChild(newNode, true, children);
					}
					if (Number.isNaN(timeValue)) {
						extensionFunctions.sendTextToOutputChannel(`Warning: Heading node "${title}" has an invalid time value set to "${timeAttr}"`)
					}
				}
				return children;
			} else if (headings && isAsciiDoc(tutUri)){
				for (const heading of headings) {
					const newNode : HeadingNode | undefined = this.getNodeFromADOCDiv(heading, tutUri, category);
					if (newNode && !this.doesNodeExist(children, newNode)) {
						newNode.contextValue = 'HeadingNode';
						this.addChild(newNode, true, children);
					}
				}
				return children;
			}
		}
		return children;
	}

	findCategoryNode(category : string) : SimpleNode | null {
		const nodeToFind = new TreeNode(category, category, undefined, vscode.TreeItemCollapsibleState.Collapsed);
		if (this.doesNodeExist(this.treeNodes, nodeToFind)) {
			return nodeToFind;
		}
		return null;
	}
	
	async findTutorialNode(category : string, tutorialName : string ) : Promise<TutorialNode | undefined> {
		const catNode = this.findCategoryNode(category);
		if (catNode) {
			const treeItems : SimpleNode[] = await this.getChildren(catNode);
			let foundNode : TreeNode | undefined = undefined;
			treeItems.forEach(element => {
				if (element instanceof TreeNode) {
					const elementAsTreeNode = element as TreeNode;
					if (elementAsTreeNode.label === tutorialName && elementAsTreeNode.category === category) {
						foundNode = elementAsTreeNode;
					}
				}
			});
			return foundNode;
		}
		return undefined;
	}

	async findHeadingNode(category : string, uri: string) : Promise<SimpleNode | null> {
		const catNode = this.findCategoryNode(category);
		if (catNode) {
			const treeItems : SimpleNode[] = await this.getChildren(catNode);
			let foundNode : TreeNode | null = null;
			treeItems.forEach(element => {
				if (element instanceof TreeNode) {
					const elementAsTreeNode = element as TreeNode;
					if (elementAsTreeNode.uri === uri && elementAsTreeNode.category === category) {
						foundNode = elementAsTreeNode;
					}
				}
			});
			return foundNode;
		}
		return null;
	}
	
}

export class SimpleNode extends vscode.TreeItem {
	category: string | undefined;
	uri : string | undefined;
	constructor(
		type: string | undefined,
		label: string,
		uri: string | undefined,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.uri = uri;
		this.category = type;
	}
}


// simple tree node for our tutorials view
export class TreeNode extends SimpleNode {
	uri : string | undefined;
	constructor(
		type: string | undefined,
		label: string,
		uri: string | undefined,
		collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(type, label, uri);
		this.collapsibleState = collapsibleState;
		this.uri = uri;
	}
}

export class TutorialNode extends TreeNode {
	constructor(
		category: string | undefined,
		label: string,
		uri: string | undefined,
		collapsibleState: vscode.TreeItemCollapsibleState,
		inTooltip? : string | undefined
	) {
		super(category, label, uri, collapsibleState);
		const localIconPath = vscode.Uri.file(path.resolve(extensionFunctions.getContext().extensionPath, 'icon/logo.svg'));
		this.iconPath = localIconPath;
		if (inTooltip) {
			this.description = inTooltip;
		}
	}
}

// simple heading node for an outline of the headings in our tutorial
export class HeadingNode extends SimpleNode {
	uri : string | undefined;
	constructor(
		category: string | undefined,
		label: string,
		uri: string | undefined,
		description : string | undefined
	) {
		super(category, label, uri);
		this.description = description;
	}
}

function retrieveTreeItemName(selection: SimpleNode) {
	const treeItemName: string | vscode.TreeItemLabel | undefined = selection.label;
	if (treeItemName === undefined) {
		return "";
	} else if(typeof treeItemName === "string") {
		return treeItemName;
	} else {
		return treeItemName.label;
	}
}
