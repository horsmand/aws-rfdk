/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';

import {
  CfnInstanceProfile,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from '@aws-cdk/aws-iam';
import {
  CfnComponent,
  CfnDistributionConfiguration,
  CfnImage,
  CfnImageRecipe,
  CfnInfrastructureConfiguration,
} from '@aws-cdk/aws-imagebuilder';
import { Asset } from '@aws-cdk/aws-s3-assets';
import {
  CfnResource,
  Construct,
  Token,
} from '@aws-cdk/core';

// import { VersionQuery } from '../version-query';

import { templateComponent } from './template';

export enum OSType {
  WINDOWS = 'Windows',
  LINUX = 'Linux'
}

export interface ImageBuilderPipelineProps {
  // Only support Linux to start, components need to be customizable to the OS
  readonly osType: OSType,

  // The parent image of the image recipe.
  // The string must be either an Image ARN (SemVers is ok) or an AMI ID.
  // For example, to get the latest vesion of your image, use "x.x.x" like:
  // arn:aws:imagebuilder:us-west-2:123456789123:image/my-image/x.x.x
  readonly parentAmi: string,

  // The image version must be bumped any time the image or any components are modified, otherwise
  // CloudFormation will fail to update.
  // Must be in the format x.x.x
  readonly imageVersion: string,

  // Customer defined components
  readonly componentArns?: string[],

  // If no version is supplied, the latest will be used
  readonly deadlineVersion?: string,

  readonly distributionConfiguration?: CfnDistributionConfiguration,

  // Default to something with enough space to install Deadline
  readonly infrastructureConfiguration?: CfnInfrastructureConfiguration,
}

export class ImageBuilderPipeline extends Construct {
  public readonly arn: string;
  public readonly amiId: string;

  constructor(scope: Construct, id: string, props: ImageBuilderPipelineProps) {
    super(scope, id);

    if (props.osType == OSType.WINDOWS) {
      throw new Error('Support for Windows Images not yet implemented');
    }

    const imageBuilderRoleName = 'DeadlineImageBuilderRole';
    const imageBuilderRole = new Role(scope, 'DeadlineImageBuilderRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      roleName: imageBuilderRoleName,
    });
    imageBuilderRole.addToPolicy(new PolicyStatement({
      actions: [
        'ec2messages:AcknowledgeMessage',
        'ec2messages:DeleteMessage',
        'ec2messages:FailMessage',
        'ec2messages:GetEndpoint',
        'ec2messages:GetMessages',
        'ec2messages:SendReply',
        'imagebuilder:GetComponent',
        's3:Get*',
        's3:List*',
        'ssm:DescribeAssociation',
        'ssm:GetDeployablePatchSnapshotForInstance',
        'ssm:GetDocument',
        'ssm:DescribeDocument',
        'ssm:GetManifest',
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:ListAssociations',
        'ssm:ListInstanceAssociations',
        'ssm:PutInventory',
        'ssm:PutComplianceItems',
        'ssm:PutConfigurePackageResult',
        'ssm:UpdateAssociationStatus',
        'ssm:UpdateInstanceAssociationStatus',
        'ssm:UpdateInstanceInformation',
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));
    imageBuilderRole.addToPolicy(new PolicyStatement({
      actions: ['logs:*'],
      resources: ['arn:aws:logs:*:*:log-group:/aws/imagebuilder/*'],
    }));

    const tagCondition: { [key: string]: any } = {};
    tagCondition['kms:EncryptionContextKeys'] = 'aws:imagebuilder:arn';
    tagCondition['aws:CalledVia'] = 'imagebuilder.amazonaws.com';
    imageBuilderRole.addToPolicy(new PolicyStatement({
      actions: [
        'kms:Decrypt',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: tagCondition,
      },
    }));

    const imageBuilderProfileName = 'DeadlineImageBuilderPolicy';
    const imageBuilderProfile = new CfnInstanceProfile(scope, 'DeadlineImageBuilderPolicy', {
      instanceProfileName: imageBuilderProfileName,
      roles: [ imageBuilderRoleName ],
    });

    imageBuilderProfile.addDependsOn(imageBuilderRole.node.defaultChild as CfnResource);

    const infrastructureConfiguration = props.infrastructureConfiguration
      ?? new CfnInfrastructureConfiguration(
        scope,
        'InfrastructureConfig',
        {
          name: 'DeadlineInfrastructureConfig2',
          instanceProfileName: imageBuilderProfileName,
        });

    infrastructureConfiguration.addDependsOn(imageBuilderProfile);

    // const version = new VersionQuery(scope, 'VersionQuery', { version: props?.deadlineVersion });
    // const linuxClientInstaller = version.linuxInstallers.client;

    const deadlineComponentDoc = new Asset(scope, 'DeadlineComponentDoc', {
      path: templateComponent({
        templatePath: path.join(__dirname, 'components', 'deadline.component.template'),
        tokens: {
          version: '10.1.12.1',
          s3Uri: 's3://thinkbox-installers/Deadline/10.1.12.1/Linux/DeadlineClient-10.1.12.1-linux-x64-installer.run',
        },
      }),
    });

    const deadlineComponent = new CfnComponent(scope, 'DeadlineComponent', {
      platform: 'Linux',
      version: '1.0.0',
      uri: deadlineComponentDoc.s3ObjectUrl,
      description: 'Installs Deadline',
      name: 'Deadline2',
    });

    const componentArnList = [{ componentArn: deadlineComponent.attrArn }];
    props.componentArns?.forEach(arn => {
      componentArnList.push({ componentArn: arn });
    });

    const imageRecipe = new CfnImageRecipe(scope, 'DeadlineRecipe', {
      components: componentArnList,
      name: 'DeadlineInstallationRecipe2',
      parentImage: props.parentAmi,
      version: props.imageVersion,
    });

    const deadlineImage = new CfnImage(scope, 'DeadlineImage', {
      imageRecipeArn: imageRecipe.attrArn,
      infrastructureConfigurationArn: infrastructureConfiguration.attrArn,
    });

    this.arn = deadlineImage.attrArn;
    this.amiId = Token.asString(deadlineImage.getAtt('ImageId'));
  }
}